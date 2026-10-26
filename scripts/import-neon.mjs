import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse";
import { neon } from "@neondatabase/serverless";
import { ageAt, transferGroupKeys } from "../server/model.mjs";
import { loadRoleGrades } from "../server/role-grades.mjs";

if (existsSync(resolve(".env"))) { for (const line of readFileSync(resolve(".env"),"utf8").split(/\r?\n/)) { const match=line.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/); if(match&&!process.env.DATABASE_URL) process.env.DATABASE_URL=match[1].replace(/^(["'])(.*)\1$/,"$2"); } }
if (!process.env.DATABASE_URL) throw new Error("Create a local .env file with DATABASE_URL first.");
const sql = neon(process.env.DATABASE_URL), dataDir = resolve(process.env.DATA_DIR || "data");
async function* rows(file) {
  const path=resolve(dataDir,file); if(!existsSync(path))return;
  yield* createReadStream(path).pipe(parse({columns:true,bom:true,skip_empty_lines:true,relax_column_count:true}));
}
async function insertBatches(items, statement, size=250) {
  for(let i=0;i<items.length;i+=size) await sql.query(statement,[JSON.stringify(items.slice(i,i+size))]);
  console.log(`Inserted ${items.length.toLocaleString()} records.`);
}
const seasonEnd = value => { const m=String(value||"").match(/^(\d{4})\D+(\d{2,4})$/); return m?`${Number(m[2])<100?2000+Number(m[2]):Number(m[2])}-07-01`:null; };
const num = value => { const s=String(value??"").trim();if(!s||s==="-")return 0;const clean=/^\d{1,3}(\.\d{3})+'$/.test(s)?s.replace(/[.']/g,""):s.replace(/[']/g,"");return Number(clean)||0; };
const month = date => { const d=new Date(`${date}T00:00:00Z`);return Number.isFinite(+d)?d.getUTCFullYear()*12+d.getUTCMonth():null; };
const bump = (map,key,fields,row) => { let x=map.get(key);if(!x){x=Object.fromEntries(fields.map(f=>[f,0]));map.set(key,x)}for(const f of fields)x[f]+=row[f]||0; };
const batchedJson = (table, cols, types, transform, items) => `INSERT INTO ${table} (${cols.join(",")}) SELECT ${cols.join(",")} FROM jsonb_to_recordset($1::jsonb) AS x(${cols.map((c,i)=>`${c} ${types[i]}`).join(",")})`;

const schema=readFileSync(resolve("database/schema.sql"),"utf8");

for(const statement of schema.split(";").map(x=>x.trim()).filter(Boolean)) await sql.query(statement);
await sql.query("TRUNCATE transfer_monthly, player_transfer_monthly, competitions");
await sql.query("TRUNCATE players CASCADE");
const players=[];for await(const r of rows("players.csv")){const id=Number(r.player_id);if(!Number.isFinite(id))continue;const data={...r};players.push({player_id:id,name:r.name||`${r.first_name||""} ${r.last_name||""}`.trim(),normalized_name:String(r.name||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase(),current_club_name:r.current_club_name||null,position:r.position||null,sub_position:r.sub_position||null,domestic_competition_id:r.current_club_domestic_competition_id||null,date_of_birth:r.date_of_birth||null,image_url:r.image_url||null,market_value_in_eur:Number(r.market_value_in_eur)||null,data});}
await insertBatches(players,`INSERT INTO players(player_id,name,normalized_name,current_club_name,position,sub_position,domestic_competition_id,date_of_birth,image_url,market_value_in_eur,data) SELECT x.player_id,x.name,x.normalized_name,x.current_club_name,x.position,x.sub_position,x.domestic_competition_id,NULLIF(x.date_of_birth,'')::date,x.image_url,x.market_value_in_eur,x.data FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,name text,normalized_name text,current_club_name text,position text,sub_position text,domestic_competition_id text,date_of_birth text,image_url text,market_value_in_eur bigint,data jsonb)`);
const playerMap=new Map(players.map(p=>[String(p.player_id),p.data]));
const valuations=[];for await(const r of rows("player_valuations.csv")){if(playerMap.has(String(r.player_id))&&r.date)valuations.push({player_id:Number(r.player_id),date:r.date,market_value_in_eur:Number(r.market_value_in_eur)||null,data:r});}
await insertBatches(valuations,`INSERT INTO valuations(player_id,date,market_value_in_eur,data) SELECT x.player_id,x.date::date,x.market_value_in_eur,x.data FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,date text,market_value_in_eur bigint,data jsonb)`);
valuations.length=0;
const monthly=new Map();for await(const r of rows("appearances.csv")){const m=month(r.date),id=String(r.player_id);if(m===null||!playerMap.has(id))continue;bump(monthly,`${id}|${m}`,["appearances","goals","assists","minutes_played","yellow_cards","red_cards"],{appearances:1,goals:num(r.goals),assists:num(r.assists),minutes_played:num(r.minutes_played),yellow_cards:num(r.yellow_cards),red_cards:num(r.red_cards)});}
await insertBatches([...monthly].map(([key,v])=>{const [player_id,month_key]=key.split("|").map(Number);return{player_id,month_key,...v}}),`INSERT INTO appearance_months(player_id,month_key,appearances,goals,assists,minutes_played,yellow_cards,red_cards) SELECT x.player_id,x.month_key,x.appearances,x.goals,x.assists,x.minutes_played,x.yellow_cards,x.red_cards FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,month_key int,appearances int,goals int,assists int,minutes_played int,yellow_cards int,red_cards int)`);
monthly.clear();
const seasonTotals=new Map();for await(const r of rows("player_performances.csv")){const end=seasonEnd(r.season_name),id=String(r.player_id);if(!end||!playerMap.has(id))continue;bump(seasonTotals,`${id}|${end}`,["appearances","goals","assists","minutes_played","clean_sheets","goals_conceded"],{appearances:num(r.nb_on_pitch),goals:num(r.goals),assists:num(r.assists),minutes_played:num(r.minutes_played),clean_sheets:num(r.clean_sheets),goals_conceded:num(r.goals_conceded)});}
await insertBatches([...seasonTotals].map(([key,v])=>{const [player_id,season_end]=key.split("|");return{player_id:Number(player_id),season_end,...v}}),`INSERT INTO season_performance(player_id,season_end,appearances,goals,assists,minutes_played,clean_sheets,goals_conceded) SELECT x.player_id,x.season_end::date,x.appearances,x.goals,x.assists,x.minutes_played,x.clean_sheets,x.goals_conceded FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,season_end text,appearances int,goals int,assists int,minutes_played int,clean_sheets int,goals_conceded int)`);
seasonTotals.clear();
const comp=[];for await(const r of rows("competitions.csv"))if(r.competition_id)comp.push({competition_id:r.competition_id,name:r.name||r.competition_code||r.competition_id,domestic_league_code:r.domestic_league_code||null});
await insertBatches(comp,`INSERT INTO competitions(competition_id,name,domestic_league_code) SELECT x.competition_id,x.name,x.domestic_league_code FROM jsonb_to_recordset($1::jsonb) AS x(competition_id text,name text,domestic_league_code text) ON CONFLICT(competition_id) DO UPDATE SET name=excluded.name,domestic_league_code=excluded.domestic_league_code`);
const grades=loadRoleGrades(dataDir,new Map(players.map(p=>[String(p.player_id),p.data]))),gradeRows=[];for(const[id,items]of grades)for(const[end,g]of items)gradeRows.push({player_id:Number(id),season_end:new Date(end).toISOString().slice(0,10),grade:g.grade,coverage:g.coverage,minutes:g.minutes,role:g.role});
await insertBatches(gradeRows,`INSERT INTO role_grades(player_id,season_end,grade,coverage,minutes,role) SELECT x.player_id,x.season_end::date,x.grade,x.coverage,x.minutes,x.role FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,season_end text,grade float8,coverage float8,minutes int,role text)`);
comp.length=0;
const transfers=new Map(), ownTransfers=new Map();
for await(const r of rows("transfers.csv")){
 const id=String(r.player_id),date=r.transfer_date,fee=Number(r.transfer_fee),value=Number(r.market_value_in_eur),m=month(date),player=playerMap.get(id);
 if(!player||m===null||!(fee>0)||!(value>0))continue;
 const age=ageAt(player.date_of_birth,date);if(age===null||age<15||age>50)continue;
 const ratio=Math.max(-2.3,Math.min(2.3,Math.log(fee/value)));
 for(const group_key of transferGroupKeys(player,age,value)){
  for(const [map,key] of [[transfers,`${group_key}|${m}`],[ownTransfers,`${id}|${group_key}|${m}`]]){let x=map.get(key);if(!x){x={count:0,log_ratio_sum:0};map.set(key,x)}x.count++;x.log_ratio_sum+=ratio;}
 }
}
await insertBatches([...transfers].map(([key,v])=>{const split=key.split("|");const month_key=Number(split.pop()),group_key=split.join("|");return{group_key,month_key,transfer_count:v.count,log_ratio_sum:v.log_ratio_sum}}),`INSERT INTO transfer_monthly(group_key,month_key,transfer_count,log_ratio_sum) SELECT x.group_key,x.month_key,x.transfer_count,x.log_ratio_sum FROM jsonb_to_recordset($1::jsonb) AS x(group_key text,month_key int,transfer_count int,log_ratio_sum float8)`);
await insertBatches([...ownTransfers].map(([key,v])=>{const split=key.split("|");const month_key=Number(split.pop()),group_key=split.slice(1).join("|"),player_id=Number(split[0]);return{player_id,group_key,month_key,transfer_count:v.count,log_ratio_sum:v.log_ratio_sum}}),`INSERT INTO player_transfer_monthly(player_id,group_key,month_key,transfer_count,log_ratio_sum) SELECT x.player_id,x.group_key,x.month_key,x.transfer_count,x.log_ratio_sum FROM jsonb_to_recordset($1::jsonb) AS x(player_id bigint,group_key text,month_key int,transfer_count int,log_ratio_sum float8)`);
console.log("Neon data import finished. Player, valuation, appearance, season, competition, and role-grade tables are populated.");
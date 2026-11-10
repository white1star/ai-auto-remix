/** Website-owned audio tasks. WorkBuddy claims and returns real local audio via MCP. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { DIRS } from './db.mjs';
import { probe, inside, extOf, sleep } from './util.mjs';
import { resolveMediaPath, userAudioDir } from './media.mjs';

const ROOT = path.join(DIRS.root, 'audio-requests');
const heartbeat = new Map();
const AUDIO = new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.wma']);
const fault = (code, message) => Object.assign(new Error(message), {code});
const folder = user => path.join(ROOT, String(user.id));
function file(user, id) {
  if (!/^a[0-9a-f]{32}$/.test(String(id))) throw fault(404,'音频任务不存在');
  return path.join(folder(user), id + '.json');
}
function save(user, row) {
  fs.mkdirSync(folder(user),{recursive:true});
  const dest=file(user,row.id), tmp=dest+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(row),'utf8');fs.renameSync(tmp,dest);
}
function load(user,id) {
  let row;try{row=JSON.parse(fs.readFileSync(file(user,id),'utf8'));}catch{throw fault(404,'音频任务不存在');}
  if(row.userId!==user.id)throw fault(404,'音频任务不存在');
  if(['queued','processing'].includes(row.status)&&Date.now()-row.updated_at>30*60*1000){row.status='error';row.error='助手处理超时，请重新生成';row.claimToken=null;row.updated_at=Date.now();save(user,row);}
  if(row.status==='error'&&row.note!=='音频处理失败'){row.note='音频处理失败';save(user,row);}
  return row;
}
function publicRow(row) { const {userId,claimToken,...out}=row;return out; }
function rows(user) {
  if(!fs.existsSync(folder(user)))return [];
  return fs.readdirSync(folder(user)).filter(n=>/^a[0-9a-f]{32}\.json$/.test(n)).map(n=>load(user,n.slice(0,-5))).sort((a,b)=>a.created_at-b.created_at);
}
function link(value) {
  const text=String(value||'').trim(), match=text.match(/https?:\/\/[^\s<>"'\]\)]+/i);
  if(!match)throw fault(400,'请填写有效的参考视频链接');
  let u;try{u=new URL(match[0]);}catch{throw fault(400,'参考视频链接不合法');}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(u.username||u.password||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||net.isIP(host)||!host.includes('.'))throw fault(400,'参考视频请使用公开的视频链接');
  if(u.href.length>4096)throw fault(400,'参考链接过长');
  return u.href;
}
export function createAudioRequest(user,input={}) {
  const script=String(input.script||'').trim();
  if(!script||script.length>8000)throw fault(400,'请填写文案（最多 8000 字）');
  const useVoice=input.useVoice!==false,useBgm=input.useBgm!==false;
  if(!useVoice&&!useBgm)throw fault(400,'请选择参考音色或参考 BGM');
  if(rows(user).filter(r=>['queued','processing'].includes(r.status)).length>=3)throw fault(429,'已有音频任务在处理，请先等待或取消');
  const voiceUrl=useVoice?link(input.separateLinks?input.voiceUrl:input.referenceUrl):'';
  const bgmUrl=useBgm?link(input.separateLinks?input.bgmUrl:input.referenceUrl):'';
  const speed=Number(input.speed??1.2);if(!Number.isFinite(speed)||speed<0.5||speed>2)throw fault(400,'语速应在 0.5–2 倍之间');
  const now=Date.now();
  const row={id:'a'+crypto.randomBytes(16).toString('hex'),userId:user.id,script,voiceUrl,bgmUrl,useVoice,useBgm,speed,status:'queued',note:'等待助手接单',voFile:null,bgm:null,error:null,claimToken:null,created_at:now,updated_at:now};
  save(user,row);return publicRow(row);
}
export const getAudioRequest=(user,id)=>publicRow(load(user,id));
export function latestAudioRequest(user){const all=rows(user);return all.length?publicRow(all[all.length-1]):null;}
export function cancelAudioRequest(user,id){const row=load(user,id);if(['queued','processing'].includes(row.status)){row.status='cancelled';row.claimToken=null;row.updated_at=Date.now();save(user,row);}return publicRow(row);}
export const assistantStatus=user=>({connected:Date.now()-(heartbeat.get(user.id)||0)<90000,lastSeen:heartbeat.get(user.id)||null});
export async function waitAudioRequest(user,seconds=0,requestedId=''){
  const end=Date.now()+Math.min(45,Math.max(0,Number(seconds)||0))*1000;
  if(requestedId&&!/^a[0-9a-f]{32}$/.test(String(requestedId)))throw fault(400,'音频任务号不合法');
  do{
    heartbeat.set(user.id,Date.now());
    const row=rows(user).find(r=>r.status==='queued'&&(!requestedId||r.id===requestedId));
    if(row){row.status='processing';row.note='助手正在处理参考音频';row.claimToken=crypto.randomBytes(24).toString('hex');row.updated_at=Date.now();save(user,row);return {request:publicRow(row),claim_token:row.claimToken};}
    if(Date.now()>=end)break;await sleep(1000);
  }while(true);
  return {request:null,next:'继续调用 wait_audio_request 等待网站任务'};
}
async function validAudio(user,raw){
  if(!raw||!AUDIO.has(extOf(raw)))throw fault(400,'请回填真实的本机音频文件');
  const r=resolveMediaPath(user,raw,{allowAudio:true});
  if(!r.ok)throw fault(r.code===403?403:400,r.error);
  const real=fs.realpathSync(r.path);
  if(inside(DIRS.audio,real)&&!inside(userAudioDir(user.id),real))throw fault(403,'无权使用其他账号的音频');
  const checked=resolveMediaPath(user,real,{allowAudio:true});if(!checked.ok)throw fault(checked.code,checked.error);
  const info=await probe(real);if(!info?.hasAudio||!info.duration)throw fault(400,'回填文件不是有效音频');
  return real;
}
export async function finishAudioRequest(user,input={}){
  let row=load(user,input.id);
  if(row.status!=='processing'||!input.claim_token||input.claim_token!==row.claimToken)throw fault(409,'任务已取消、过期或领取凭据不匹配');
  heartbeat.set(user.id,Date.now());
  if(input.error){row.status='error';row.error=String(input.error).slice(0,600);row.note='音频处理失败';row.claimToken=null;row.updated_at=Date.now();save(user,row);return publicRow(row);}
  if(input.note&&!input.vo_file&&!input.bgm_file){row.note=String(input.note).slice(0,200);row.updated_at=Date.now();save(user,row);return publicRow(row);}
  const voice=row.useVoice?await validAudio(user,input.vo_file):null;
  const music=row.useBgm?await validAudio(user,input.bgm_file):null;
  // Recheck after probing: a website cancellation while ffprobe ran must win.
  row=load(user,input.id);if(row.status!=='processing'||row.claimToken!==input.claim_token)throw fault(409,'任务已取消或过期');
  const copied=[];
  try{
    for(const [key,src]of[['voFile',voice],['bgm',music]]){
      if(!src)continue;const dest=path.join(userAudioDir(user.id),row.id+'-'+key+extOf(src));fs.copyFileSync(src,dest);copied.push(dest);row[key]=dest;
    }
    row.status='done';row.note='音频已回填，可以试听';row.claimToken=null;row.updated_at=Date.now();save(user,row);
  }catch(e){for(const dest of copied)try{fs.unlinkSync(dest);}catch{}throw e;}
  return publicRow(row);
}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (r, res, b) => { r.rawBody = b; } }));

const cw = axios.create({ baseURL: 'https://api.chatwork.com/v2', headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' } });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let isG = false, lRst = null; 
const spms = {}, gSt = {};
let betLogs = [], cmSt = null, mkSt = null;

sb.from('config').select('value').eq('key', 'gamble_active').maybeSingle().then(r => { if(r.data) isG = r.data.value === 'true'; }).catch(()=>{});

const getT = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getM = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fN = n => Number(n).toLocaleString();
const vf = (req) => { const s = req.headers['x-chatworkwebhooksignature']; return s && s === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64'); };

const mkRp = (a, r, m) => `[rp aid=${a} to=${r}-${m}]`;
const sendM = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const sendT = async (rid, txt, ms = 60000) => { try { const r = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`); if(r?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${r.data.message_id}`).catch(()=>{}), ms); } catch(e){} };

const addMoney = async (aid, amt) => {
    const { data: p } = await sb.from('players').select('*').eq('account_id', aid).maybeSingle();
    let m = p ? p.money : 0, d = p ? (p.debt || 0) : 0; let diff = amt;
    if (d > 0 && amt > 0) { let r = Math.min(d, amt); d -= r; amt -= r; } m += amt;
    if (p) await sb.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money: m, debt: d, slot_count: 0, work_limit: 5, msg_count: 0, slot_limit: 5, job: 'サラリーマン' });
    if (diff !== 0) { betLogs.push({ aid, diff, t: Date.now() }); betLogs = betLogs.filter(l => Date.now() - l.t <= 300000); }
};

const applyCM = async (loss) => {
    if (cmSt && Date.now() < cmSt.exp && loss > 0) { let a = Math.floor(loss * 0.5); if (a > 0) await addMoney(cmSt.aid, a); }
};

const isAd = async (rid, aid) => { try { const { data } = await cw.get(`/rooms/${rid}/members`); return data.find(x => x.account_id.toString() === aid.toString())?.role.match(/admin|creator/); } catch(e) { return false; } };

const kickTgt = async (rid, aids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`); if(!c) return;
        let ad=c.filter(m=>m.role.match(/admin|creator/)).map(m=>m.account_id.toString()), me=c.filter(m=>m.role==='member').map(m=>m.account_id.toString()), ro=c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let f = false;
        for (let a of aids) { let id = a.toString(); if(ad.includes(id)||me.includes(id)||ro.includes(id)) f=true; ad=ad.filter(x=>x!==id); me=me.filter(x=>x!==id); ro=ro.filter(x=>x!==id); if(act==='readonly') ro.push(id); }
        if(!f) return; const p = new URLSearchParams(); if(ad.length) p.append('members_admin_ids', ad.join(',')); if(me.length) p.append('members_member_ids', me.join(',')); if(ro.length) p.append('members_readonly_ids', ro.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e){}
};

const chkSpam = (a) => { const n = Date.now(); if(!spms[a]) spms[a]=[]; spms[a].push(n); spms[a]=spms[a].filter(t=>n-t<=5000); return spms[a].length>=10; };

// --- 🏇競馬・🃏ポーカー エンジン ---
const genDb = () => {
    let st=[]; for(let i=0;i<6;i++) st.push(Math.random()*10+1);
    let cb=[], tW=0, mp={}, s="";
    for(let i=1;i<=5;i++){ for(let j=i+1;j<=6;j++){ let w=st[i-1]*st[j-1]; cb.push({c:`${i}-${j}`,w}); tW+=w; } }
    cb.forEach(c => { let o=(0.8/(c.w/tW)).toFixed(1); if(o<1.1)o=1.1; if(o>150)o=150.0; mp[c.c]=Number(o); });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : [code]${mp[k]}倍[/code]\n`; });
    return { mp, s, st };
};

const getPkDk = () => {
    const su = ['♠','♥','♣','♦'], rk = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; let dk = [];
    for (let s of su) for (let i = 0; i < rk.length; i++) dk.push({ s, r: rk[i], v: i + 2 });
    for (let i = dk.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [dk[i], dk[r]] = [dk[r], dk[i]]; } return dk;
};

const evPk = (c) => {
    let v=c.map(x=>x.v).sort((a,b)=>b-a), s=c.map(x=>x.s), fl=s.every(x=>x===s[0]), st=false, stH=0;
    if(v[0]-v[4]===4 && new Set(v).size===5) { st=true; stH=v[0]; } else if(v.join(',')==="14,5,4,3,2") { st=true; stH=5; }
    let ct={}; v.forEach(x=>ct[x]=(ct[x]||0)+1); let cA=Object.keys(ct).map(k=>[parseInt(k),ct[k]]).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
    let r=1, tb=[];
    if(fl&&st){ if(stH===14){r=10;tb=[14];}else{r=9;tb=[stH];} }else if(cA[0][1]===4){r=8;tb=[cA[0][0],cA[1][0]];}else if(cA[0][1]===3&&cA[1][1]===2){r=7;tb=[cA[0][0],cA[1][0]];}else if(fl){r=6;tb=v;}else if(st){r=5;tb=[stH];}else if(cA[0][1]===3){r=4;tb=[cA[0][0],cA[1][0],cA[2][0]];}else if(cA[0][1]===2&&cA[1][1]===2){r=3;tb=[cA[0][0],cA[1][0],cA[2][0]];}else if(cA[0][1]===2){r=2;tb=[cA[0][0],cA[1][0],cA[2][0],cA[3][0]];}else{r=1;tb=v;}
    const n=["","ハイカード","ワンペア","ツーペア","スリーカード","ストレート","フラッシュ","フルハウス","フォーカード","ストレートフラッシュ","ロイヤルフラッシュ"], m=[1,1,1,2,3,4,5,10,20,50,100];
    return { r, n: n[r], m: m[r], tb };
};
const cpPk = (p1, p2) => { if(p1.r>p2.r)return 1; if(p1.r<p2.r)return -1; for(let i=0;i<p1.tb.length;i++){ if(p1.tb[i]>p2.tb[i])return 1; if(p1.tb[i]<p2.tb[i])return -1; } return 0; };

// --- ゲーム進行管理 ---
const sTmr = (rid, ms=60000, isDb=false) => {
    let g = gSt[rid]; if (!g) return;
    if(g.tid) clearTimeout(g.tid); if(g.rt) clearTimeout(g.rt);
    if(isDb) g.rt = setTimeout(() => { if (gSt[rid]?.s === 'BET') sendT(rid, `[info]⏳ 競馬ベット締切1分前です！\n[code]/bet [額] [馬1-馬2][/code] でベット！[/info]`); }, ms - 60000);
    g.tid = setTimeout(() => hTO(rid), ms);
};

const cPrg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'BET' && g.p.length >= 2 && g.p.every(x => x.b > 0)) {
        if (g.t === 'db') { clearTimeout(g.tid); if(g.rt) clearTimeout(g.rt); await rsDb(rid); }
        else {
            g.s = 'ACT'; let txt = g.t === 'ch' ? `丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。` : `親以外は [code]/draw[/code] で手札を引いてください！`;
            await sendT(rid, `[info][title]🎲 進行フェーズ[/title]全員ベット完了！\n${txt}\n[hr](制限1分)[/info]`); sTmr(rid, 60000);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.length >= 2 && g.p.every(x => x.c)) await rsCh(rid);
        if (g.t === 'pk' && g.p.length >= 2 && g.p.filter(x=>x.a!==g.h).every(x => x.res)) await rsPk(rid);
    }
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'REC') {
        if (g.p.length >= 2) {
            g.s = 'BET';
            if (g.t === 'db') { await sendT(rid, `[info][title]⏳ ゲーム開始[/title]【 🐎 馬連オッズ 】\n${g.oS}\n👉 [code]/bet [額] [馬1]-[馬2][/code] (例:/bet 100 1-2)\n(制限2分。残り1分でリマインド)[/info]`, 120000); sTmr(rid, 120000, true); }
            else { await sendT(rid, `[info][title]⏳ ゲーム開始[/title]👉 [code]/bet [額][/code] でベット！\n(制限1分。/bet max|half 可)[/info]`); sTmr(rid, 60000); }
        } else { await sendT(rid, `[info]⚠️ 参加者不足で中止。[/info]`); gSt[rid] = null; }
    } else {
        let kk = [], ac = [];
        for (let p of g.p) {
            let k = false; if(g.s === 'BET' && p.b === 0) k=true; if(g.s === 'ACT' && (g.t==='ch'&&!p.c || g.t==='pk'&&!p.res&&p.a!==g.h)) k=true;
            if (k) { kk.push(p.a); if (p.b > 0) await addMoney(p.a, p.b); } else ac.push(p);
        }
        g.p = ac;
        if (kk.length > 0) await sendT(rid, `[info]⏳ タイムアウト退出・返金:\n${kk.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        if (g.p.length < 2) { for (let p of g.p) if (p.b > 0) await addMoney(p.a, p.b); await sendT(rid, `[info]中止・返金[/info]`); gSt[rid] = null; } 
        else await cPrg(rid);
    }
};

// --- 精算 ---
const rsPk = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let h = []; for(let i=0;i<5;i++) h.push(g.dk.pop()); let pR = { hand: h, ...evPk(h) };
    if (mkState && Math.random() < 0.8) { let mkP = g.p.find(x=>x.a===mkState.a); if(mkP) { if(mkP.a===g.h) pR={r:10,n:"ロイヤルフラッシュ",m:100,hand:[],tb:[14]}; else mkP.res={r:10,n:"ロイヤルフラッシュ",m:100,hand:[],tb:[14]}; } mkState=null; }
    let msg = `[info][title]🃏 ポーカー結果[/title]親([piconname:${g.h}])\n[${pR.hand.map(c=>c.s+c.r).join(' ')}] ➡ ${pR.n}\n[hr]プレイヤー\n`;
    for (let p of g.p) {
        if (p.a === g.h) continue;
        let r = p.res || { r: -1, n: "欠席", m: 1, hand: [], tb: [] };
        if (r.r === -1) { msg += `💀 [piconname:${p.a}]: 欠席 (没収)\n`; await applyCM(p.b); continue; }
        let c = cpPk(r, pR);
        if (c === 0) { await addMoney(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join('')}] ${r.n} ➡ 引分(返金)\n`; }
        else if (c > 0) { let ml = r.m>0?r.m:1; await addMoney(p.a, p.b+(p.b*ml)); msg += `(cracker) [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join('')}] ${r.n} ➡ 勝利(+${fNum(p.b*ml)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join('')}] ${r.n} ➡ 敗北\n`; await applyCM(p.b); }
    }
    await sendM(rid, msg+"[/info]"); gSt[rid] = null;
};

const rsCh = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1=Math.floor(Math.random()*6)+1, d2=Math.floor(Math.random()*6)+1, s=d1+d2, ans=(s%2===0)?'chou':'han';
    if (mkState && Math.random() < 0.8) { let mkP = g.p.find(x=>x.a===mkState.a); if(mkP&&mkP.c){ ans=mkP.c; if(ans==='chou'){d1=2;d2=2;s=4;}else{d1=1;d2=2;s=3;} } mkState=null; }
    let msg = `[info][title]🎲 丁半結果[/title]出目: ${d1}, ${d2} (計${s}) ➡ 『 ${ans==='chou'?'丁(偶数)':'半(奇数)'} 』\n[hr]`;
    for (let p of g.p) {
        if (p.c === ans) { await addMoney(p.a, p.b*2); msg += `(cracker) [piconname:${p.a}]: 的中！(+${fNum(p.b*2)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: はずれ...\n`; await applyCM(p.b); }
    }
    await sendM(rid, msg+"[/info]"); gSt[rid] = null;
};

const rsDb = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid); if(g.rt) clearTimeout(g.rt);
    let st=g.st, ws=[...st], tW=ws.reduce((a,b)=>a+b,0), r1=Math.random()*tW, s1=0, f=1;
    for(let i=0;i<6;i++){ s1+=ws[i]; if(r1<=s1){ f=i+1; break; } }
    ws[f-1]=0; tW=ws.reduce((a,b)=>a+b,0); let r2=Math.random()*tW, s2=0, s=1;
    for(let i=0;i<6;i++){ s2+=ws[i]; if(r2<=s2){ s=i+1; break; } }
    let wC = f<s ? `${f}-${s}` : `${s}-${f}`;
    if (mkState && Math.random() < 0.8) { let mkP = g.p.find(x=>x.a===mkState.a); if(mkP&&mkP.c){ wC=mkP.c; f=parseInt(wC.split('-')[0]); s=parseInt(wC.split('-')[1]); } mkState=null; }
    let odd = g.mp[wC], msg = `[info][title]🐎 ダービー結果[/title]1着: ${f}番 / 2着: ${s}番\n🎯 的中馬連: 【 ${wC} 】 (${odd}倍)\n[hr]`;
    for(let p of g.p){
        if(p.c === wC){ let wA = Math.floor(p.b*odd); await addMoney(p.a, p.b+wA); msg += `(cracker) [piconname:${p.a}]: 的中！(+${fNum(wA)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: 外れ\n`; await applyCM(p.b); }
    }
    await sendM(rid, msg+"[/info]"); gSt[rid] = null;
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event; if (!ev || ev.webhook_event_type !== 'message_created') return;
    const rid = ev.room_id, body = ev.body.trim(), sId = ev.account_id.toString(), mId = ev.message_id;
    const td = getTodayStr(), tM = getThisMonthStr();

    (async () => {
        try {
            const rM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i); const rA = rM?rM[1]:null;

            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).maybeSingle();
            if(isB){ await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            if(chkSpam(sId) && !(await isUserAdmin(rid, sId))){ await kickTarget(rid, [sId], 'readonly'); return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} 連投につき閲覧制限[/info]`); }

            let { data: p } = await sb.from('players').select('*').eq('account_id', sId).maybeSingle();
            if (!p && isGamble && !body.startsWith('/')) { await sb.from('players').insert({account_id:sId, money:0, debt:0, slot_count:0, work_limit:5, msg_count:1, slot_limit:5, job:'サラリーマン'}); p = { money:0, debt:0, job:'サラリーマン', slot_count:0, work_limit:5, slot_limit:5 }; }

            if (localLastResetDate !== td) {
                const {data:ld} = await sb.from('config').select('value').eq('key','last_reset_date').maybeSingle();
                if(!ld || ld.value!==td){
                    await sb.from('players').update({slot_count:0, work_limit:5, work_date:null, skill_date:null, omikuji_date:null}).neq('account_id','0');
                    await sb.from('config').upsert({key:'last_reset_date', value:td}); localLastResetDate=td;
                    let m=`[info][title]🔄 日付更新[/title]スロット・仕事回数リセット！\n[hr]`;
                    const {data:tD} = await sb.from('config').select('value').eq('key','lottery_tickets').maybeSingle();
                    let tks=tD?JSON.parse(tD.value):[];
                    if(tks.length>0){
                        let win=Math.floor(Math.random()*9999)+1; m+=`[title]🎯 宝くじ結果[/title]当選番号:【 ${win} 】\n[hr]`;
                        let py={}, ws=[];
                        const cP=(n,w)=>{
                            if(n===w) return {p:30000,n:'🥇1等'}; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return {p:15000,n:'🥈前後賞'};
                            if(n%1000===w%1000) return {p:10000,n:'🥈2等'}; if(n%100===w%100) return {p:5000,n:'🥉3等'}; if(n%10===w%10) return {p:1000,n:'🏅4等'}; return null;
                        };
                        for(let t of tks){ let r=cP(t.num,win); if(r){ ws.push({a:t.aid, num:t.num, ...r}); py[t.aid]=(py[t.aid]||0)+r.p; } }
                        if(ws.length>0){
                            for(let a in py) await addMoney(a, py[a]);
                            ws.sort((a,b)=>b.p-a.p); for(let w of ws.slice(0,20)) m+=`✨ ${mkRp(w.a,rid,mId)} [${w.num}] ➡ ${w.n} (+${fNum(w.p)})\n`;
                            if(ws.length>20) m+=`...他 ${ws.length-20} 件\n`;
                        } else m+=`当選者なし\n`;
                        await sb.from('config').upsert({key:'lottery_tickets', value:'[]'});
                    } sendMsg(rid, m+"[/info]");
                }
            }

            if (isGamble && p && !body.startsWith('/')) {
                let mc = (p.msg_count||0)+1; let wl = p.work_limit||5;
                if (mc >= (Math.floor(Math.random()*21)+30)) { mc=0; if(wl<10)wl++; }
                await sb.from('players').update({msg_count:mc, work_limit:wl}).eq('account_id', sId);
            }

            if(body==='/help-gya') return sendTempMessage(rid, `[info][title]🎰 案内[/title]/status, /give, /debt, /money-rank, /job, /work, /catch, /goal, /cm, /KK, /MK, /slot, /buy-lot, /chouhan, /poker, /derby, /bet [額|max|half]\n管理: /take, /st-gya, /fi-gya, /fi-game, /blacklist, /remove-rank[/info]`, 120000);

            if(/(^|\n)\/take\b/.test(body) && isGamble && await isUserAdmin(rid, sId)) {
                let a = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2]||(body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rA || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if(tg && a>0) { await addMoney(tg, a); return sendTempMessage(rid, `[info]👑 ${mkRp(tg,rid,mId)} へ ${fNum(a)} 資金付与[/info]`); }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && isGamble && await isUserAdmin(rid, sId)) {
                if (gSt[rid] && gSt[rid].state !== 'IDLE') {
                    for (let x of gSt[rid].players) if (x.bet > 0) await addMoney(x.aid, x.bet);
                    clearTimeout(gSt[rid].timeoutId); if(gSt[rid].remindId) clearTimeout(gSt[rid].remindId); gSt[rid] = null;
                    return sendTempMessage(rid, `[info]⚠️ 管理者がゲームを強制終了・返金しました。[/info]`);
                } else return sendTempMessage(rid, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if(/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)){
                let tg=rA||(body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/)||[])[2];
                let cmd=body.includes('/remove-rank')?'rank':(body.includes('/reblacklist')?'rm':'ad');
                if(!tg&&cmd!=='ad') return; if(!tg&&cmd==='ad') cmd='ls';
                if(cmd==='rank'){
                    const {data:eD} = await sb.from('config').select('value').eq('key','rank_excluded').maybeSingle();
                    let ex=eD?JSON.parse(eD.value):[];
                    if(ex.includes(tg)){ ex=ex.filter(i=>i!==tg); sendTempMessage(rid, `[info]${mkRp(tg,rid,mId)} ランク除外解除[/info]`); }
                    else{ ex.push(tg); sendTempMessage(rid, `[info]${mkRp(tg,rid,mId)} ランク除外[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if(cmd==='ad'){ await sb.from('blacklist').insert({account_id:tg}); await kickTarget(rid,[tg],'readonly'); return sendTempMessage(rid, `[info]🚫 ${mkRp(tg,rid,mId)} BL登録[/info]`); }
                else if(cmd==='rm'){ await sb.from('blacklist').delete().eq('account_id',tg); return sendTempMessage(rid, `[info]✅ ${mkRp(tg,rid,mId)} BL解除[/info]`); }
                else if(cmd==='ls'){ const {data:ls}=await sb.from('blacklist').select('account_id'); return sendTempMessage(rid, `[info][title]📜 BL一覧[/title]${ls&&ls.length?ls.map(d=>`[piconname:${d.account_id}]`).join('\n'):'なし'}[/info]`); }
            }

            if(body.startsWith('/st-gya') && await isUserAdmin(rid,sId)){ gambleActive=true; await sb.from('config').upsert({key:'gamble_active',value:'true'}); return sendMsg(rid, `[info]🎰 カジノON[/info]`); }
            if(body.startsWith('/fi-gya') && await isUserAdmin(rid,sId)){ gambleActive=false; await sb.from('config').upsert({key:'gamble_active',value:'false'}); return sendMsg(rid, `[info]🚫 カジノOFF[/info]`); }

            let mM=p?p.money:0, mD=p?(p.debt||0):0, mJ=p?(p.job||'サラリーマン'):'サラリーマン', cDb=(p&&p.debt_month===tM)?(p.monthly_debt||0):0, mSL=p?(p.slot_limit||5):5;

            if (/(^|\n)\/omikuji\b/.test(body) && isGamble) {
                if (p?.omikuji_date === today) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} 既におみくじを引いています。[/info]`);
                let r = Math.random() * 100, res = r < 10 ? "大吉" : r < 30 ? "中吉" : r < 60 ? "小吉" : r < 85 ? "吉" : r < 95 ? "凶" : "大凶";
                await sb.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                return sendMsg(rid, `[info]⛩️ ${mkRp(sId,rid,mId)} 運勢: 【 ${res} 】！[/info]`);
            }

            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if(dbM && isGamble){
                let a=parseInt(dbM[2],10);
                if(a>0){
                    if(cDb+a>5000) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} 月の借金上限(5000)です！[/info]`);
                    if(p) await sb.from('players').update({money:mM+a, debt:mD+a, monthly_debt:cDb+a, debt_month:tM}).eq('account_id',sId);
                    else await sb.from('players').insert({account_id:sId, money:a, debt:a, monthly_debt:a, debt_month:tM});
                    return sendTempMessage(rid, `[info]💳 ${mkRp(sId,rid,mId)} ${fNum(a)}コイン借金しました。[/info]`);
                }
            }

            if(/(^|\n)\/give/.test(body) && isGamble){
                let tg=rA||(body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a=parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2]||(body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3],10);
                if(tg&&a>0){
                    let av=Math.max(0,mM-mD); if(av<a) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} 送金枠不足！[/info]`);
                    let tx=Math.floor(a*0.10); let rA=a-tx;
                    await sb.from('players').update({money:mM-a}).eq('account_id',sId);
                    const {data:rc}=await sb.from('players').select('*').eq('account_id',tg).maybeSingle();
                    if(rc) await sb.from('players').update({money:rc.money+rA}).eq('account_id',tg); else await sb.from('players').insert({account_id:tg, money:rA, debt:0});
                    return sendTempMessage(rid, `[info]🎁 ${mkRp(sId,rid,mId)} ➡ ${mkRp(tg,rid,mId)}\n${fNum(a)}送金 (税${fNum(tx)}, 受取${fNum(rA)})[/info]`);
                }
            }

            if(body==='/status') return sendTempMessage(rid, `[info][title]📊 状態[/title]${mkRp(sId,rid,mId)}\n💰: ${fNum(mM)}${mD>0?`\n💳: -${fNum(mD)}`:''}\n💎: ${fNum(mM-mD)}\n👔: ${myJ}\n🎰: 残${Math.max(0,mSL-(p?p.slot_count:0))} / 💼: 残${p?p.work_limit:0}\n⛩️: ${p?.omikuji_result||'未'}[/info]`);
            if(body==='/money-rank'){
                const {data:ex}=await sb.from('config').select('value').eq('key','rank_excluded').maybeSingle(); let eI=ex?JSON.parse(ex.value):[];
                const {data:ls}=await sb.from('players').select('*'); let f=ls?ls.filter(d=>!eI.includes(d.account_id)):[];
                f.sort((a,b)=>((b.money||0)-(b.debt||0))-((a.money||0)-(a.debt||0)));
                let s=f.slice(0,10).map((d,i)=>{let n=(d.money||0)-(d.debt||0); let md=i===0?"🥇":(i===1?"🥈":(i===2?"🥉":"🔹")); return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 ${fNum(n)} ${d.debt>0?`(借:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;}).join('\n[hr]');
                return sendTempMessage(rid, `[info][title]👑 純資産ランキング[/title]${s}[/info]`, 300000);
            }

            const jM=body.match(/^\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
            if(jM && isGamble){
                const jn=jM[1]; const cs={'サラリーマン':0, '公務員':2000, '警察官':3000, 'プロスポーツ選手':5000, '賭博師':100000, 'マスター':700000, 'タイムトラベラー':1000000};
                if(myJ===jn) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} 既に${jn}です`);
                if(mM<cs[jn]) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} お金不足`);
                if(p) await sb.from('players').update({job:jn, money:mM-cs[jn]}).eq('account_id',sId); else await sb.from('players').insert({account_id:sId, job:jn, money:-cs[jn]});
                return sendTempMessage(rid, `[info]💼 ${mkRp(sId,rid,mId)} ${jn} に転職しました！[/info]`);
            } else if(body==='/job' && isGamble) return sendTempMessage(rid, `[info][title]💼 求人[/title]サラリーマン(0)\n公務員(2000)\n警察官(3000)\nプロ(5000)\n賭博師(10万)\nマスター(70万)\nトラベラー(100万)\n※転職は /job 役職名[/info]`);

            if(body==='/work' && isGamble && p){
                if(p.work_limit<=0) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} 本日上限`);
                if(Date.now()-(p.last_work_time||0)<600000) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} 休憩中(10分間隔)`);
                let e=0; let m="";
                if(myJ==='サラリーマン'){ if(Math.random()<0.1){e=0;m="ミスで給料0...";} else {e=Math.floor(Math.random()*401)+100;m=`${fNum(e)}獲得`;} }
                else if(myJ==='公務員'){ e=Math.floor(Math.random()*201)+300; m=`${fNum(e)}獲得`; }
                else if(myJ==='警察官'){ e=Math.floor(Math.random()*401)+300; m=`${fNum(e)}獲得`; }
                else if(myJ==='プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`${fNum(e)}獲得`; }
                else if(myJ==='賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`${fNum(e)}獲得`; }
                else if(myJ==='マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`${fNum(e)}獲得`; }
                else if(myJ==='タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`${fNum(e)}調達`; }
                await sb.from('players').update({last_work_time:Date.now(), work_limit:p.work_limit-1}).eq('account_id',sId);
                await addMoneyWithRepay(sId, e); return sendTempMessage(rid, `[info]💼 ${mkRp(sId,rid,mId)}\n${m} (残${p.work_limit-1})[/info]`);
            }

            if(/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/.test(body) && isGamble && p){
                let cmd = body.match(/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/)[2];
                if(cmd==='catch'&&myJ!=='警察官') return; if(cmd==='goal'&&myJ!=='プロスポーツ選手') return; if(cmd==='slot-up'&&myJ!=='賭博師') return; if(cmd==='cm'&&myJ!=='マスター') return; if((cmd==='KK'||cmd==='MK')&&myJ!=='タイムトラベラー') return;
                if(p.skill_date===today) return sendTempMessage(rid, `⚠️ 本日使用済`);
                let m="";
                if(cmd==='catch'){ if(Math.random()<0.3){ await addMoneyWithRepay(sId,800); m=`逮捕！特別報酬 800 獲得！`;} else m=`逃しました...`; }
                else if(cmd==='goal'){ if(Math.random()<0.3){ await addMoneyWithRepay(sId,1000); m=`スーパーゴール！ 1000 獲得！`;} else m=`シュートは外れました...`; }
                else if(cmd==='slot-up'){ let nl=Math.floor(Math.random()*6)+10; await sb.from('players').update({slot_limit:nl}).eq('account_id',sId); m=`本日のスロット上限が ${nl} 回にアップ！`; }
                else if(cmd==='cm'){ if(Math.random()<0.5){ cmState={aid:sId, expire:Date.now()+1800000}; m=`30分間、他人の負け額50%を吸収します！`;} else m=`失敗...`; }
                else if(cmd==='MK'){ mkState={aid:sId}; m=`次のゲームで奇跡が起こります！`; }
                else if(cmd==='KK'){ let nw=Date.now(), tgs=betLogs.filter(l=>nw-l.time<=300000), dfs={}; for(let l of tgs){ if(!dfs[l.aid])dfs[l.aid]=0; dfs[l.aid]-=l.diff; } for(let a in dfs){ if(dfs[a]!==0) await addMoneyWithRepay(a,dfs[a]); } betLogs=[]; cmState=null; mkState=null; m=`過去5分間のギャンブル損益を全て無効化しました！`; }
                await sb.from('players').update({skill_date:today}).eq('account_id',sId);
                return sendTempMessage(rid, `[info]✨ ${mkRp(sId,rid,mId)}\n${m}[/info]`);
            }

            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && isGamble && p) {
                if (p.slot_count >= mSL) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} 本日上限(${mSL}回)`);
                if (Date.now()-(p.last_slot_time||0)<120000) return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} 休憩中(2分間隔)`);
                let b = sM[2]==='max'?mM:(sM[2]==='half'?Math.floor(mM/2):parseInt(sM[2],10)); b=Math.min(b,99999);
                if (b>0 && mM>=b) {
                    await sb.from('players').update({money:mM-b, slot_count:p.slot_count+1, last_slot_time:Date.now()}).eq('account_id',sId);
                    logBet(sId, -b);
                    let r=Math.random()*100, omi=(p.omikuji_date===today)?p.omikuji_result:null, oM="";
                    if(omi==='大吉'){ r=Math.max(0,r-0.4); oM="(⛩️大吉!)"; } else if(omi==='中吉'){ r=Math.max(0,r-0.2); oM="(⛩️中吉)"; } else if(omi==='凶'){ r+=0.05; } else if(omi==='大凶'){ r+=0.09; }
                    if(mkState && mkState.aid===sId && Math.random()<0.8){ r=0.05; mkState=null; oM="(👁️MK発動!)"; }
                    let ml=0, sy="", rs="";
                    if(r<0.1){ml=30;sy="🐉 | 🐉 | 🐉";rs="🔥 超大当たり！！！(30倍)";}else if(r<3.1){ml=10;sy="7️⃣ | 7️⃣ | 7️⃣";rs="✨ 大当たり！(10倍)";}else if(r<9.1){ml=3;let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)];sy=`${s} | ${s} | ${s}`;rs="(cracker) 当たり！(3倍)";}else if(r<19.1){ml=2;let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)];sy=`${s} | ${s} | ${s}`;rs="(cracker) 当たり！(2倍)";}else if(r<29.1){ml=2;let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)];sy=`${s} | ${s} | ${s}`;rs="🍇 フルーツ揃い！(2倍)";}else if(r<49.1){ml=2;let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];let s1=o[Math.floor(Math.random()*o.length)],s2=o[Math.floor(Math.random()*o.length)];let a=["🍒",s1,s2].sort(()=>Math.random()-0.5);sy=a.join(" | ");rs="🍒 チェリー！(2倍)";}else{ml=0;let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];let r1=o[Math.floor(Math.random()*o.length)],r2=o[Math.floor(Math.random()*o.length)],r3=o[Math.floor(Math.random()*o.length)];while(r1===r2&&r2===r3)r3=o[Math.floor(Math.random()*o.length)];sy=`${r1} | ${r2} | ${r3}`;rs="💀 はずれ...";}
                    let wA=b*ml; if(wA>0) await addMoneyWithRepay(sId,wA); else await applyCM(b);
                    return sendMessage(rid, `[info][title]🎰 SLOT ${oM}[/title]${mkRp(sId,rid,mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${rs}\n\n賭: ${fNum(b)} ➡ 獲: ${fNum(wA)}\n(残: ${mSL-(p.slot_count+1)}回)[/info]`);
                } else return sendTempMessage(rid, `⚠️ ${mkRp(sId,rid,mId)} お金不足`);
            }

            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if(lM && isGamble){
                let md = lM[2]||'バラ', cnt = lM[3]?parseInt(lM[3],10):1;
                if(cnt>0 && cnt<=100){
                    let cost=cnt*100; if(mM<cost) return sendTempMessage(rid, `⚠️ お金不足！(${cnt}枚=${fNum(cost)})`);
                    const {data:lD} = await sb.from('config').select('value').eq('key','lottery_tickets').maybeSingle();
                    let tks=lD?JSON.parse(lD.value):[], uN=new Set(tks.map(t=>t.num)), mN=[];
                    if(md==='連番'){
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0;i<10000;i++){ let s=((rs+i)%(10000-cnt))+1; let ok=true; for(let j=0;j<cnt;j++){ if(uN.has(s+j)){ok=false;break;} } if(ok){st=s;break;} }
                        if(st===-1) return sendTempMessage(rid, `⚠️ 連続空き番号なし`);
                        for(let j=0;j<cnt;j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1;i<=9999;i++) if(!uN.has(i)) av.push(i);
                        if(av.length<cnt) return sendTempMessage(rid, `⚠️ 残りくじ不足`);
                        for(let i=av.length-1;i>0;i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN=av.slice(0,cnt);
                    }
                    await sb.from('players').update({money:mM-cost}).eq('account_id',sId); logBet(sId, -cost);
                    for(let n of mN) tks.push({aid:sId,num:n}); await sb.from('config').upsert({key:'lottery_tickets',value:JSON.stringify(tks)});
                    let ns=mN.length>5?mN.slice(0,5).join(', ')+` ...他${cnt-5}枚`:mN.join(', ');
                    return sendTempMessage(rid, `[info]🎟 宝くじ ${cnt}枚（${md}）購入！\n番号: ${ns}[/info]`);
                }
            }

            if (body.match(/(^|\n)\/(chouhan|poker|derby)\b/) && isGamble) {
                if (gSt[rid]) return sendTempMessage(rid, `⚠️ 進行中のゲームあり`);
                let t = body.includes('/derby') ? 'db' : (body.includes('/poker') ? 'pk' : 'ch');
                gSt[rid] = { type: t, state: 'REC', host: sId, players: [{ aid: sId, bet: 0 }] };
                let tN = t==='db'?"🐎 ダービー":(t==='pk'?"🃏 ポーカー":"🎲 丁半"); let ex = t==='db'?"[code]/join derby[/code]":(t==='pk'?"[code]/join poker[/code]":"[code]/join chouhan[/code]");
                if (t === 'db') { let dO = generateDerby(); gSt[rid].oMp = dO.oddsMap; gSt[rid].oS = dO.oddsStr; gSt[rid].st = dO.stats; }
                if (t === 'pk') { gSt[rid].dk = getPokerDeck(); }
                sendTempMessage(rid, `[info][title]${tN} 募集開始[/title]親: [piconname:${sId}]\n参加は ${ex}\n[hr]ホストが [code]/start${t==='chouhan'?'chouhan':t}[/code] で進行。[/info]`); 
                return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|poker|derby)/) && isGamble && gSt[rid]?.state === 'REC') {
                if (!gSt[rid].players.find(x => x.aid === sId)) { gSt[rid].players.push({ aid: sId, bet: 0 }); sendMessage(rid, `[info]🙋‍♂️ [piconname:${sId}] 参加！ (${gSt[rid].players.length}人)[/info]`); }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|poker|derby)/) && isGamble && gSt[rid]?.state === 'REC' && gSt[rid].host === sId) {
                if (gSt[rid].players.length < 2) return sendTempMessage(rid, `⚠️ 2人以上必要`);
                gSt[rid].state = 'BETTING';
                if (gSt[rid].type === 'db') {
                    await sendMessage(rid, `[info][title]⏳ ベット受付[/title]【 🐎 馬連オッズ 】\n${gSt[rid].oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code]\n(2分。1分前通知)[/info]`);
                    startGameTimer(rid, 120000, true);
                } else {
                    await sendMessage(rid, `[info][title]⏳ ベット受付[/title]👉 [code]/bet [額][/code] でベット！\n[hr](制限1分)[/info]`);
                    startGameTimer(rid, 60000);
                }
                return;
            }

            if (body.trim() === '/leave' && isGamble && gSt[rid]) {
                let idx = gSt[rid].players.findIndex(x => x.aid === sId);
                if (idx !== -1) {
                    let p = gSt[rid].players[idx]; gSt[rid].players.splice(idx, 1);
                    if (p.bet > 0) { await addMoneyWithRepay(sId, p.bet); logBet(sId, p.bet); } 
                    sendTempMessage(rid, `[info]🚪 [piconname:${sId}] 退出[/info]`);
                    if (gSt[rid].players.length === 0) { clearTimeout(gSt[rid].timeoutId); if(gSt[rid].remindId) clearTimeout(gSt[rid].remindId); gSt[rid] = null; return sendTempMessage(rid, `[info]⚠️ 参加者0で中止[/info]`); }
                    checkGameProgress(rid);
                } return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && isGamble && gSt[rid]?.state === 'BETTING') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10)); b = Math.min(b, 99999); 
                    if (b > 0 && myMoney >= b) {
                        if (gSt[rid].type === 'db') { let h = bM[3]; if (!h || !gSt[rid].oMp[h]) return sendTempMessage(rid, `⚠️ 馬連(1-2等)を指定して下さい`); pl.choice = h; }
                        pl.bet = b; await supabase.from('players').update({ money: myMoney - b }).eq('account_id', sId); logBet(sId, -b); 
                        sendTempMessage(rid, `[info]💰 [piconname:${sId}] ${fNum(b)} ベット！[/info]`); checkGameProgress(rid);
                    } else sendTempMessage(rid, `⚠️ ${mkRp(sId, rid, mId)} お金不足`);
                } return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && isGamble && gSt[rid]?.type === 'chouhan' && gSt[rid].state === 'ACTION') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && !pl.choice) { pl.choice = body.trim().slice(1); sendTempMessage(roomId, `[info]🎯 [piconname:${sId}] 「${pl.choice==='chou'?'丁':'半'}」を選択！[/info]`); checkGameProgress(rid); }
            }

            if (body.trim() === '/draw' && isGamble && gSt[rid]?.type === 'poker' && gSt[rid].state === 'ACTION') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && !pl.res && sId !== gSt[rid].host) {
                    let hand = []; for(let i=0; i<5; i++) hand.push(gSt[rid].dk.pop());
                    pl.res = { hand, ...evalPoker(hand) };
                    sendMessage(rid, `[info]🃏 [piconname:${sId}] の役: ${pl.res.n}[/info]`); checkGameProgress(rid);
                }
            }

        } catch (error) { 
            // もしエラーが起きてもBotを落とさず、チャットに原因を通知する安全装置
            sendTempMessage(roomId, `[info]⚠️ システムエラー発生\n${error.message}[/info]`);
        }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

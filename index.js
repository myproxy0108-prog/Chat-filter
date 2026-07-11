const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client ---
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let isGamble = false, lastReset = null; 
const spams = {}, gSt = {};

sb.from('config').select('value').eq('key', 'gamble_active').single().then(r => { if(r.data) isGamble = r.data.value === 'true'; }).catch(()=>{});

// --- Date Utils ---
const getJST = () => new Date(Date.now() + 32400000);
const getToday = () => getJST().toISOString().split('T')[0];
const getMonth = () => getJST().toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySig = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    return sig && sig === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

// --- Chatwork Messages ---
const mkRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;
const sendMsg = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const sendTemp = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- お金・借金管理 ---
const addMoney = async (aid, amount) => {
    const { data: p } = await sb.from('players').select('*').eq('account_id', aid).single();
    let m = p ? p.money : 0, d = p ? (p.debt || 0) : 0;
    if (d > 0 && amount > 0) { let r = Math.min(d, amount); d -= r; amount -= r; }
    m += amount;
    if (p) await sb.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money: m, debt: d, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 0, job: 'サラリーマン' });
};

// --- 特殊能力サポート ---
const saveHistory = async () => {
    try {
        const { data: pList } = await sb.from('players').select('account_id, money');
        const { data: hD } = await sb.from('config').select('value').eq('key', 'money_history').single();
        let hist = hD ? JSON.parse(hD.value) : [];
        hist.push({ time: Date.now(), states: pList });
        hist = hist.filter(h => Date.now() - h.time <= 300000); // 5分保持
        await sb.from('config').upsert({ key: 'money_history', value: JSON.stringify(hist) });
    } catch(e) {}
};

const consumeMirai = async (aid) => {
    try {
        const { data } = await sb.from('config').select('value').eq('key', 'mirai_buff').single();
        if (data && data.value === aid.toString()) {
            await sb.from('config').update({ value: '' }).eq('key', 'mirai_buff');
            return Math.random() < 0.8; // 80%で成功
        }
        return false;
    } catch(e) { return false; }
};

const applyMasterTax = async (lostAmt) => {
    try {
        const { data } = await sb.from('config').select('value').eq('key', 'master_buff').single();
        if (data && data.value) {
            let b = JSON.parse(data.value);
            if (b.expire > Date.now()) {
                let tax = Math.floor(lostAmt * 0.5);
                if (tax > 0) await addMoney(b.aid, tax);
            }
        }
    } catch(e) {}
};

// --- 防衛機能 ---
const isAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTgt = async (rid, aids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`);
        let ad = c.filter(m=>m.role==='admin'||m.role==='creator').map(m=>m.account_id.toString());
        let me = c.filter(m=>m.role==='member').map(m=>m.account_id.toString());
        let ro = c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let f = false;
        for (let a of aids) {
            let id = a.toString();
            if (ad.includes(id) || me.includes(id) || ro.includes(id)) f = true;
            ad = ad.filter(x=>x!==id); me = me.filter(x=>x!==id); ro = ro.filter(x=>x!==id);
            if (act === 'readonly') ro.push(id);
        }
        if (!f) return;
        const p = new URLSearchParams();
        if (ad.length) p.append('members_admin_ids', ad.join(','));
        if (me.length) p.append('members_member_ids', me.join(','));
        if (ro.length) p.append('members_readonly_ids', ro.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e) {}
};

const chkSpam = (aid) => {
    const n = Date.now();
    if (!spams[aid]) spams[aid] = [];
    spms[aid].push(n);
    spms[aid] = spms[aid].filter(t => n - t <= 5000);
    return (spms[aid].length >= 10);
};

// --- ゲームエンジン ---
const genDerby = () => {
    let st = []; for(let i=0; i<6; i++) st.push(Math.random() * 10 + 1);
    let cb = [], tW = 0, mp = {}, s = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = st[i-1]*st[j-1]; cb.push({c:`${i}-${j}`, w}); tW += w; } }
    cb.forEach(c => { let o = (0.8/(c.w/tW)).toFixed(1); if(o<1.1)o=1.1; if(o>150)o=150.0; mp[c.c] = Number(o); });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : [code]${mp[k]}倍[/code]\n`; });
    return { mp, s, st };
};

const getRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if(d[0]===1&&d[1]===1&&d[2]===1) return { d, n: "ピンゾロ", r: 6, s: 1, m: 5 };
        if(d[0]===d[1]&&d[1]===d[2]) return { d, n: `${d[0]}の嵐`, r: 5, s: d[0], m: 3 };
        if(d[0]===4&&d[1]===5&&d[2]===6) return { d, n: "シゴロ", r: 4, s: 6, m: 2 };
        if(d[0]===1&&d[1]===2&&d[2]===3) return { d, n: "ヒフミ", r: 0, s: 0, m: -2 };
        if(d[0]===d[1]) return { d, n: `${d[2]}の目`, r: 2, s: d[2], m: 1 };
        if(d[1]===d[2]) return { d, n: `${d[0]}の目`, r: 2, s: d[0], m: 1 };
        if(d[0]===d[2]) return { d, n: `${d[1]}の目`, r: 2, s: d[1], m: 1 };
    }
    return { d: [0,0,0], n: "目なし", r: 1, s: 0, m: 1 };
};

const genDeck = () => {
    const s = ['♠','♥','♣','♦'], rk = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'], dk = [];
    for(let u of s) for(let k of rk) dk.push({ s:u, r:k, v:k==='A'?1:(['J','Q','K'].includes(k)?10:parseInt(k)) });
    for(let i=dk.length-1; i>0; i--) { const r=Math.floor(Math.random()*(i+1)); [dk[i],dk[r]]=[dk[r],dk[i]]; } return dk;
};
const calcBj = (h) => { let sc=0, a=0; for(let c of h){ if(c.r==='A'){a++;sc+=11;} else sc+=c.v; } while(sc>21&&a>0){sc-=10;a--;} return sc; };

// --- ゲーム進行＆タイムアウト ---
const setTmr = (rid, ms = 60000, isDb = false) => {
    let g = gSt[rid]; if (!g) return;
    if (g.tid) clearTimeout(g.tid); if (g.rtid) clearTimeout(g.rtid);
    if (isDb) g.rtid = setTimeout(() => { if (gSt[rid]?.s === 'BET') sendTemp(rid, `[info]⏳ 競馬のベット締切1分前です！[/info]`); }, ms - 60000);
    g.tid = setTimeout(() => hTO(rid), ms);
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    let minP = g.t === 'bj' ? 1 : 2;
    if (g.s === 'BET' && g.p.length >= minP && g.p.every(p => p.b > 0)) {
        if (g.t === 'db') { clearTimeout(g.tid); if(g.rtid) clearTimeout(g.rtid); await resDb(rid); }
        else if (g.t === 'bj') {
            g.s = 'ACT'; g.dk = genDeck(); g.dH = [g.dk.pop(), g.dk.pop()];
            let m = `[info][title]🃏 ブラックジャック開始[/title]全員ベット完了！\n\n【ディーラー】\n🎴 ${g.dH[0].s}${g.dH[0].r} / [裏]\n[hr]【プレイヤー】\n`;
            for(let p of g.p) {
                p.h = [g.dk.pop(), g.dk.pop()]; let sc = calcBj(p.h);
                m += `[piconname:${p.a}]: ${p.h.map(c=>c.s+c.r).join(' ')} (スコア:${sc})`;
                if(sc===21){ p.st='bj'; m+=` 🎉 BJ！\n`; } else { p.st='playing'; m+=`\n`; }
            }
            await sendTemp(rid, m+"[/info]", 120000); g.tn = 0; await nxBj(rid);
        } else {
            g.s = 'ACT';
            let txt = g.t === 'ch' ? "[code]/chou[/code] (丁) または [code]/han[/code] (半) を予想してください。" : "親以外は [code]/roll[/code] で振ってください。";
            await sendTemp(rid, `[info][title]🎲 ゲーム進行[/title]全員ベット完了！\n${txt}\n[hr](※制限1分)[/info]`);
            setTmr(rid, 60000);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.length >= 2 && g.p.every(p => p.c)) await resCh(rid);
        if (g.t === 'cc' && g.p.length >= 2 && g.p.filter(x=>x.a!==g.h).every(p => p.res)) await resCc(rid);
    }
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    let minP = g.t === 'bj' ? 1 : 2;

    if (g.s === 'REC') {
        if (g.p.length >= minP) {
            g.s = 'BET';
            if (g.t === 'db') {
                await sendTemp(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]【🐎馬連オッズ】\n${g.oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code]\n(制限2分。 /bet max 等も可)[/info]`, 120000);
                setTmr(rid, 120000, true);
            } else {
                await sendTemp(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]👉 [code]/bet [額][/code] でベットしてください。\n(制限1分。 /bet max 等も可)[/info]`);
                setTmr(rid, 60000);
            }
        } else { await sendTemp(rid, `[info]⚠️ 人数不足のためゲームを中止します。[/info]`); gSt[rid] = null; }
    } else if (g.s === 'BET' || g.s === 'ACT') {
        let kick = [], act = [];
        for (let p of g.p) {
            let isK = false;
            if (g.s === 'BET' && p.b === 0) isK = true;
            if (g.s === 'ACT') {
                if (g.t === 'ch' && !p.c) isK = true;
                if (g.t === 'cc' && !p.res && p.a !== g.h) isK = true;
                if (g.t === 'bj' && p.st === 'playing') { p.st = 'stand'; await sendTemp(rid, `[info]⏳ [piconname:${p.a}] 様は時間切れにより自動スタンドしました。[/info]`); }
            }
            if (isK && g.t !== 'bj') { kick.push(p.a); if (p.b > 0) await addMoney(p.a, p.b); } 
            else act.push(p);
        }
        g.p = act;
        if (kick.length > 0) await sendTemp(rid, `[info][title]⏳ タイムアウト[/title]1分間放置したため、以下の方を退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        
        if (g.p.length < minP && g.t !== 'bj') {
            for (let p of g.p) if (p.b > 0) await addMoney(p.a, p.b);
            await sendTemp(rid, `[info]⚠️ 人数不足になったため中止し、全額返金しました。[/info]`); gSt[rid] = null;
        } else {
            if (g.t === 'bj' && g.s === 'ACT') { g.tn++; await nxBj(rid); } else await chkProg(rid);
        }
    }
};

const nxBj = async (rid) => {
    let g = gSt[rid]; if (!g || g.t !== 'bj') return;
    while (g.tn < g.p.length) {
        let p = g.p[g.tn]; if (p.st !== 'playing') { g.tn++; continue; }
        await sendTemp(rid, `[info][title]🃏 ターン進行[/title][piconname:${p.a}] さんの番です！\n手札: ${p.h.map(c=>c.s+c.r).join(' ')} (スコア: ${calcBj(p.h)})\n\n👉 [code]/hit[/code] または [code]/stand[/code] を入力してください。(制限1分)[/info]`);
        setTmr(rid, 60000); return;
    }
    await resBj(rid);
};

// --- 結果精算 ---
const resCc = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pR = getRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${g.h}])の出目 】\n[ ${pR.d.join(',')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        if (p.a === g.h) continue;
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let isM = await consumeMirai(p.a), win = isM || (r.r > pR.r) || (r.r === pR.r && r.s > pR.s), drw = !isM && (r.r === pR.r && r.s === pR.s);
        if (isM) msg += `🌟 未来改変発動！\n`;
        if (drw) { await addMoney(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
        else if (win) { let m = r.m>0?r.m:1; await addMoney(p.a, p.b+(p.b*m)); msg += `(cracker) [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.b*m)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 負け\n`; await applyMasterTax(p.b); }
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null;
};

const resCh = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1, sum = d1+d2, ans = (sum%2===0)?'chou':'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${ans==='chou'?'丁(偶数)':'半(奇数)'} 』の勝ち！\n[hr]`;
    for (let p of g.p) {
        let isM = await consumeMirai(p.a), win = isM || p.c === ans;
        if (isM) msg += `🌟 未来改変発動！\n`;
        if (win) { await addMoney(p.a, p.b*2); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(p.b*2)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: 予想[${p.c==='chou'?'丁':'半'}] ➡ はずれ...\n`; await applyMasterTax(p.b); }
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null;
};

const resDb = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid); if(g.rtid) clearTimeout(g.rtid);
    let st=g.st, ws=[...st], tW=ws.reduce((a,b)=>a+b,0), r1=Math.random()*tW, s1=0, f=1;
    for(let i=0;i<6;i++){ s1+=ws[i]; if(r1<=s1){ f=i+1; break; } } ws[f-1]=0; tW=ws.reduce((a,b)=>a+b,0);
    let r2=Math.random()*tW, s2=0, se=1; for(let i=0;i<6;i++){ s2+=ws[i]; if(r2<=s2){ se=i+1; break; } }
    let wC = f<se ? `${f}-${se}`:`${se}-${f}`, od = g.oMp[wC];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${f} 】番と【 ${se} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${wC} 】 (${od}倍)\n[hr]【 プレイヤー結果 】\n`;
    for(let p of g.p){
        let isM = await consumeMirai(p.a), win = isM || p.c === wC;
        if (isM) msg += `🌟 未来改変発動！\n`;
        if (win) { let wA = Math.floor(p.b * (isM && p.c!==wC ? (g.oMp[p.c]||2) : od)); await addMoney(p.a, p.b+wA); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(wA)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: 予想[${p.c}] ➡ はずれ...\n`; await applyMasterTax(p.b); }
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null;
};

const resBj = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let dH = g.dH, dS = 0, dA = 0;
    const up = () => { dS=0; dA=0; for(let c of dH){if(c.r==='A'){dA++;dS+=11;}else dS+=c.v;} while(dS>21&&dA>0){dS-=10;dA--;} };
    up(); let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラー 】\n伏せカードは ${dH[1].s}${dH[1].r} でした。\n`;
    while(dS < 17) { let c=g.dk.pop(); dH.push(c); up(); msg+=`➡ 引いた: ${c.s}${c.r}\n`; }
    msg += `最終手札: ${dH.map(c=>c.s+c.r).join(' ')} (スコア: ${dS})\n`; if(dS>21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        let pS = calcBj(p.h), rT = "", wA = 0;
        let isM = await consumeMirai(p.a); if (isM) { msg += `🌟 未来改変発動！\n`; p.st = 'playing'; pS = 21; dS = 22; }
        
        if (p.st === 'bust') { rT = `💀 負け (バースト)`; await applyMasterTax(p.b); } 
        else if (p.st === 'bj') {
            if (dS===21&&dH.length===2) { rT=`😐 引き分け (BJ同士)`; await addMoney(p.a, p.b); }
            else { wA=Math.floor(p.b*2.5); rT=`(cracker) 勝利(BJ)！ (+${fNum(wA)})`; await addMoney(p.a, p.b+wA); }
        } else {
            if (dS>21||pS>dS) { wA=p.b*2; rT=`(cracker) 勝利！ (+${fNum(wA)})`; await addMoney(p.a, p.b+wA); }
            else if (pS===dS) { rT=`😐 引き分け`; await addMoney(p.a, p.b); }
            else { rT=`💀 負け`; await applyMasterTax(p.b); }
        }
        msg += `[piconname:${p.a}]: スコア ${pS} ➡ ${rT}\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null;
};
const calcBj = (h) => { let sc=0, a=0; for(let c of h){if(c.r==='A'){a++;sc+=11;}else sc+=c.v;} while(sc>21&&a>0){sc-=10;a--;} return sc; };
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySig(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getToday(), tM = getMonth();

    (async () => {
        try {
            // 返信タグの解析
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // ブラックリスト
            const { data: isB } = await sb.from('blacklist').select('account_id').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            // スパム
            if (checkSpam(sId) && !(await isUserAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTemp(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投につき発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 日替わりリセット & 宝くじ
            if (localLastResetDate !== today) {
                const { data: cD } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!cD || cD.value !== today) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    let m = `[info][title]🔄 日付更新[/title]深夜0時です。各種制限がリセットされました！\n[hr]`;
                    const { data: tD } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tD ? JSON.parse(tD.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号:【 ${win} 】\n[hr]`;
                        let pays = {}, ws = [];
                        const chP = (n, w) => {
                            if(n===w) return {p:30000, n:'🥇 1等'}; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return {p:15000, n:'🥈 前後賞'};
                            if(n%1000===w%1000) return {p:10000, n:'🥈 2等'}; if(n%100===w%100) return {p:5000, n:'🥉 3等'}; if(n%10===w%10) return {p:1000, n:'🏅 4等'}; return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r){ ws.push({a:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (ws.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            ws.sort((a,b)=>b.p-a.p); for(let w of ws.slice(0,20)) m+=`(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)})\n`;
                            if(ws.length>20) m+=`...他 ${ws.length-20} 件の当選！\n`;
                        } else m+=`本日の当選者はいませんでした。\n`;
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMsg(rid, m + `[/info]`);
                }
            }

            // 履歴保存 (過去改変用・10%の確率で記録)
            if (gambleActive && Math.random() < 0.1) recordMoneyHistory();

            // プレイヤーデータ取得 & 仕事回復
            let { data: p } = await sb.from('players').select('*').eq('account_id', sId).single();
            if (!p && gambleActive && !body.startsWith('/')) {
                p = { account_id: sId, money: 0, debt: 0, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 1, job: 'サラリーマン' };
                await sb.from('players').insert(p);
            } else if (gambleActive && p && !body.startsWith('/')) {
                let mc = (p.msg_count || 0) + 1, wl = p.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                p.msg_count = mc; p.work_limit = wl;
                await sb.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = p?p.money:0, myD = p?(p.debt||0):0, myJ = p?(p.job||'サラリーマン'):'サラリーマン', cDb = (p&&p.debt_month===tM)?(p.monthly_debt||0):0;

            // --- ヘルプ ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V42 FINAL)[/title]
【 🏦 銀行 】
[code]/status[/code] : 状態確認
[code]/give [金額][/code] : 相手に送金 (税金10%)
[code]/debt [金額][/code] : 借金 (月上限5000)
[code]/money-rank[/code] : 純資産ランキング

【 💼 職業 】
[code]/job[/code] : 転職と求人
[code]/work[/code] : 職業給料 (上限1日5回)
[code]/catch[/code], [code]/goal[/code] 等 : 職業専用能力 (1日1回)
[code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 ゲーム 】
[code]/slot [掛金|max|half][/code] : スロット (1日3回, 2分間隔)
[code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ
[code]/chouhan[/code] : 丁半ゲーム
[code]/cc[/code] : チンチロリン
[code]/derby[/code] : ダービー
[code]/bj[/code] : ブラックジャック

【 👑 管理者 】
[code]/take [金][/code] : 特別資金付与
[code]/fi-game[/code] : ゲーム強制終了・返金
[code]/st-gya[/code], [code]/fi-gya[/code] : 有効化/無効化
[code]/blacklist[/code] : 追放[/info]`;
                return sendTemp(rid, h, 120000);
            }

            // --- 👑 管理者 ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (tg && amt > 0) { await addMoney(tg, amt); return sendTemp(rid, `[info]👑 [piconname:${tg}] 様へ ${fNum(amt)} 付与しました。[/info]`); }
            }
            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                if (gSt[rid] && gSt[rid].state !== 'IDLE') {
                    for (let x of gSt[rid].players) if (x.bet > 0) await addMoney(x.aid, x.bet);
                    clearTimeout(gSt[rid].timeoutId); if (gSt[rid].remindId) clearTimeout(gSt[rid].remindId);
                    gSt[rid] = null; return sendTemp(rid, `[info]⚠️ 管理者がゲームを強制終了し全額返還しました。[/info]`);
                }
            }
            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!tg && cmd !== 'add') return; if (!tg && cmd === 'add') cmd = 'list';
                if (cmd === 'rank') {
                    const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i=>i!==tg); sendTemp(rid, `[info][piconname:${tg}] ランク除外を解除しました。[/info]`); }
                    else { ex.push(tg); sendTemp(rid, `[info][piconname:${tg}] ランクから除外しました。[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await sb.from('blacklist').insert({account_id: tg}); await kickTarget(rid, [tg], 'readonly'); return sendTemp(rid, `[info]🚫 [piconname:${tg}] をBL登録しました。[/info]`); }
                else if (cmd === 'remove') { await sb.from('blacklist').delete().eq('account_id', tg); return sendTemp(rid, `[info]✅ [piconname:${tg}] のBLを解除しました。[/info]`); }
                else if (cmd === 'list') { const { data: ls } = await sb.from('blacklist').select('account_id'); const s = ls&&ls.length ? ls.map(d=>`[piconname:${d.account_id}]`).join('\n') : "なし"; return sendTemp(rid, `[info][title]📜 BL一覧[/title]${s}[/info]`); }
            }
            if (body.startsWith('/st-gya') && await isUserAdmin(rid, sId)) { gambleActive = true; await sb.from('config').upsert({key:'gamble_active', value:'true'}); return sendMsg(rid, `[info]🎰 カジノ＆ライフ 【 有効 】[/info]`); }
            if (body.startsWith('/fi-gya') && await isUserAdmin(rid, sId)) { gambleActive = false; await sb.from('config').upsert({key:'gamble_active', value:'false'}); return sendMsg(rid, `[info]🚫 カジノ＆ライフ 【 停止 】[/info]`); }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (p?.omikuji_date === today) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のおみくじは既に引いています。(${p.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通り。"; } 
                else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通り。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
                else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                await sb.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                return sendMsg(rid, `[info][title]⛩️ おみくじ[/title]${mkRp(sId, rid, mId)}\n今日の運勢: 【 ${res} 】\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && gambleActive) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (a > 99999) return sendTemp(rid, `[info]⚠️ 借金の上限は 99,999 コインです！[/info]`);
                    if (cDb + a > 5000) return sendTemp(rid, `[info]⚠️ 月の借金上限(5000)を超過します！(今月既に ${cDb})[/info]`);
                    if (p) await sb.from('players').update({ money: myM+a, debt: myD+a, monthly_debt: cDb+a, debt_month: tM }).eq('account_id', sId);
                    else await sb.from('players').insert({ account_id: sId, money: a, debt: a, monthly_debt: a, debt_month: tM });
                    return sendTemp(rid, `[info]💳 [piconname:${sId}] 様\n${fNum(a)} コイン借金しました。(枠残り ${fNum(5000 - (cDb + a))})[/info]`);
                }
            }
            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, myM - myD); if (av < a) return sendTemp(rid, `[info]⚠️ 送金枠(純資産)不足！(可能額: ${fNum(av)})[/info]`);
                    let tx = Math.floor(a * 0.10); let rAmt = a - tx;
                    await sb.from('players').update({ money: myM - a }).eq('account_id', sId);
                    const { data: rc } = await sb.from('players').select('*').eq('account_id', tg).single();
                    if (rc) await sb.from('players').update({ money: rc.money + rAmt }).eq('account_id', tg);
                    else await sb.from('players').insert({ account_id: tg, money: rAmt, debt: 0 });
                    return sendTemp(rid, `[info]🎁 [piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(a)} コイン送金 (税-${fNum(tx)}, 相手に ${fNum(rAmt)} 届きました)[/info]`);
                }
            }

            if (body.trim() === '/status') {
                const remS = Math.max(0, 3 + (p?.extra_slots||0) - (p?.slot_count||0));
                return sendTemp(rid, `[info][title]📊 状態[/title][piconname:${sId}]\n💰所持: ${fNum(myM)}\n💳借金: -${fNum(myD)}\n💎純資産: ${fNum(myM - myD)}\n[hr]👔職業: ${myJ}\n🎰スロット残: ${remS}回 / 💼仕事残: ${p?.work_limit||0}回\n⛩️運勢: ${p?.omikuji_result || '未引'}[/info]`);
            }
            if (body.trim() === '/money-rank') {
                const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single(); let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await sb.from('players').select('*'); let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰純資産: ${fNum(net)} ${d.debt>0 ? `(借:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTemp(rid, `[info][title]👑 純資産ランキング[/title]${s}\n[hr]※5分で消滅[/info]`, 300000);
            }

            // --- 💼 職業 ---
            const jM = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
            if (jM && gambleActive) {
                const jn = jM[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, '賭博師': 100000, 'マスター': 700000, 'タイムトラベラー': 1000000};
                if (myJ === jn) return sendTemp(rid, `[info]⚠️ すでに ${jn} です！[/info]`);
                if (myM < cs[jn]) return sendTemp(rid, `[info]⚠️ お金が足りません(費用: ${fNum(cs[jn])})[/info]`);
                await sb.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                return sendTemp(rid, `[info]🎉 [piconname:${sId}] 様\n「${jn}」に転職しました！ (-${fNum(cs[jn])})[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTemp(rid, `[info][title]💼 求人[/title]
👨‍💼 サラリーマン(0) ➡ [code]/work[/code] (100〜500)
🏛️ 公務員(2000) ➡ [code]/work[/code] (300〜500)
🚓 警察官(3000) ➡ [code]/work[/code] (300〜700) / [code]/catch[/code] (30%で800)
⚽ プロスポーツ選手(5000) ➡ [code]/work[/code] (500〜1000) / [code]/goal[/code] (30%で1000)
🎲 賭博師(10万) ➡ [code]/work[/code] (3000〜5000) / [code]/boostslot[/code] (スロット枠+5〜10)
🎩 マスター(70万) ➡ [code]/work[/code] (1万〜1.5万) / [code]/changemaster[/code] (他人の敗北額50%吸収)
⏳ タイムトラベラー(100万) ➡ [code]/work[/code] (1.5万〜2万) / [code]/過去改変[/code] / [code]/未来改変[/code]
[hr]※転職: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive && p) {
                if (p.work_limit <= 0) return sendTemp(rid, `[info]⚠️ 本日の仕事回数が上限です。[/info]`);
                let e = 0, m = "";
                if(myJ === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="ミスをして給料0..."; } else { e=Math.floor(Math.random()*401)+100; m=`${fNum(e)} コイン稼いだ！`; } }
                else if(myJ === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`${fNum(e)} コイン稼いだ！`; }
                else if(myJ === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`${fNum(e)} コイン稼いだ！`; }
                else if(myJ === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`${fNum(e)} コイン稼いだ！`; }
                else if(myJ === '賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`${fNum(e)} コイン稼いだ！`; }
                else if(myJ === 'マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`${fNum(e)} コイン稼いだ！`; }
                else if(myJ === 'タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`${fNum(e)} コイン稼いだ！`; }
                
                await sb.from('players').update({ work_limit: p.work_limit - 1 }).eq('account_id', sId);
                await addMoney(sId, e); 
                return sendTemp(rid, `[info]💼 [piconname:${sId}]\n${m}\n(残り ${p.work_limit - 1} 回)[/info]`);
            }

            // 特殊能力
            if (/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/.test(body) && gambleActive && p) {
                let sk = body.match(/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/)[2];
                if (sk==='catch'&&myJ!=='警察官') return; if (sk==='goal'&&myJ!=='プロスポーツ選手') return;
                if (sk==='boostslot'&&myJ!=='賭博師') return; if (sk==='changemaster'&&myJ!=='マスター') return;
                if ((sk==='過去改変'||sk==='未来改変')&&myJ!=='タイムトラベラー') return;
                
                if (p.skill_date === today) return sendTemp(rid, `[info]⚠️ 今日の特殊能力は使用済みです！[/info]`);
                let m = "";
                if (sk === 'catch') { let s=Math.random()<0.3; let e=s?800:0; if(s){ m=`逮捕！特別報酬 ${e} 獲得！🚨`; await addMoney(sId, e); } else m=`逃しました...🏃‍♂️`; }
                else if (sk === 'goal') { let s=Math.random()<0.3; let e=s?1000:0; if(s){ m=`スーパーゴール！ ${e} 獲得！🥅`; await addMoney(sId, e); } else m=`外れました...🤦‍♂️`; }
                else if (sk === 'boostslot') { let ex = Math.floor(Math.random()*6)+5; await sb.from('players').update({ extra_slots: p.extra_slots + ex }).eq('account_id', sId); m=`スロット上限が ${ex} 回増えました！🎰`; }
                else if (sk === 'changemaster') {
                    if (Math.random() < 0.5) { await sb.from('config').upsert({ key: 'master_buff', value: JSON.stringify({ aid: sId, expire: Date.now() + 1800000 }) }); m=`成功！30分間、他人の敗北額の50%を吸収します！🎩`; }
                    else m = `失敗...今日は調子が悪いようです。`;
                }
                else if (sk === '未来改変') { await sb.from('config').upsert({ key: 'mirai_buff', value: sId }); m=`✨ 次のゲームで80%の確率で当たるように未来を書き換えました！⏳`; }
                else if (sk === '過去改変') {
                    const { data: hD } = await sb.from('config').select('value').eq('key', 'money_history').single();
                    if (hD) {
                        let h = JSON.parse(hD.value);
                        if (h.length > 0) {
                            let old = h[0].states; for (let o of old) { await sb.from('players').update({ money: o.money }).eq('account_id', o.account_id); }
                            m=`🕰️ 過去を改変し、5分前の状態に戻しました...！`;
                        } else m=`戻すべき過去の記録がありませんでした...`;
                    }
                }
                await sb.from('players').update({ skill_date: today }).eq('account_id', sId);
                return sendTemp(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive && p) {
                let maxS = 3 + (p.extra_slots || 0);
                if (p.slot_count >= maxS) return sendTemp(rid, `[info]⚠️ 本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(p.last_slot_time || 0) < 120000) return sendTemp(rid, `[info]⚠️ スロット休憩中(2分間隔)です！[/info]`);
                
                let b = sM[2] === 'max' ? myM : (sM[2] === 'half' ? Math.floor(myM / 2) : parseInt(sM[2], 10));
                if (b > 99999) return sendTemp(rid, "⚠️ 賭け上限は 99,999 コインです！");
                
                if (b > 0 && myM >= b) {
                    await sb.from('players').update({ money: myM - b, slot_count: p.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', sId);
                    
                    let r = Math.random() * 100, omi = (p.omikuji_date === today) ? p.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=30; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (30倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = b * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendMsg(rid, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(b)} ➡ 獲得: ${fNum(wA)}\n(残り: ${maxS - (p.slot_count + 1)}回)[/info]`);
                } else return sendTemp(rid, `[info]⚠️ お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; if(myM < cost) return sendTemp(rid, `⚠️ お金不足(${cnt}枚=${fNum(cost)}コイン)`);
                    const {data:lD} = await sb.from('config').select('value').eq('key','lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ let s = ((rs+i) % (10000-cnt)) + 1; let ok = true; for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ok=false;break;} } if(ok){ st=s; break; } }
                        if(st === -1) return sendTemp(rid, `⚠️ 空き番号なし`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTemp(rid, `⚠️ 残りくじ不足`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN = av.slice(0, cnt);
                    }
                    await sb.from('players').update({ money: myM - cost }).eq('account_id', sId);
                    for (let n of mN) tks.push({ aid: sId, num: n }); await sb.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTemp(rid, `[info]🎟 [piconname:${sId}] 宝くじ ${cnt}枚（${md}）購入！\n番号: ${ns}[/info]`);
                }
            }

            // --- 🎲 ゲーム (募集・進行) ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby|bj)\b/) && gambleActive) {
                if (gSt[rid]) return sendTemp(rid, `[info]⚠️ 別のゲームが進行中です。[/info]`);
                let t = body.includes('/derby') ? 'db' : (body.includes('/cc') ? 'cc' : (body.includes('/bj') ? 'bj' : 'ch'));
                gSt[rid] = { type: t, state: 'REC', host: sId, players: [{ aid: sId, bet: 0 }] };
                let tN = t==='db'?"🐎 ダービー":(t==='cc'?"🎲 チンチロ":(t==='bj'?"🃏 ブラックジャック":"🎲 丁半")); 
                let ex = t==='db'?"[code]/join derby[/code]":(t==='cc'?"[code]/join cc[/code]":(t==='bj'?"[code]/join bj[/code]":"[code]/join chouhan[/code]"));
                if (t === 'db') { let d = genDerby(); gSt[rid].oMp = d.oddsMap; gSt[rid].oS = d.oddsStr; gSt[rid].st = d.stats; }
                sendTemp(rid, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${sId}]\n\n参加者は ${ex} と入力！\n[hr]※開始・進行は自動で行われます。[/info]`); 
                startTmr(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby|bj)/) && gambleActive && gSt[rid]?.state === 'REC') {
                if (!gSt[rid].players.find(x => x.aid === sId)) { gSt[rid].players.push({ aid: sId, bet: 0 }); sendMsg(rid, `[info]🙋‍♂️ [piconname:${sId}] 参加！[/info]`); }
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gSt[rid]) {
                let i = gSt[rid].players.findIndex(x => x.aid === sId);
                if (i !== -1) {
                    let cp = gSt[rid].players[i]; gSt[rid].players.splice(i, 1);
                    if (cp.bet > 0) await addMoney(sId, cp.bet);
                    sendTemp(rid, `[info]🚪 [piconname:${sId}] 退出しました。[/info]`);
                    if (gSt[rid].players.length === 0) { clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt); gSt[rid] = null; return sendTemp(rid, `[info]⚠️ 参加者0人で中止[/info]`); }
                    chkProg(rid);
                } return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gSt[rid]?.state === 'BET') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myM : (bM[2] === 'half' ? Math.floor(myM/2) : parseInt(bM[2], 10));
                    if (b > 99999) return sendTemp(rid, `⚠️ 賭け上限は 99999 コインです！`);
                    if (b > 0 && myM >= b) {
                        if (gSt[rid].type === 'db') { let h = bM[3]; if (!h || !gSt[rid].oMp[h]) return sendTemp(rid, `⚠️ 馬連(1-2など)を指定してね`); pl.choice = h; }
                        pl.bet = b; await sb.from('players').update({ money: myM - b }).eq('account_id', sId);
                        sendTemp(rid, `[info]💰 [piconname:${sId}] ${fNum(b)} コインベット！[/info]`); chkProg(rid);
                    } else sendTemp(rid, `⚠️ お金が足りません！`);
                } return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gSt[rid]?.type === 'ch' && gSt[rid].state === 'ACT') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && !pl.choice) { pl.choice = body.trim().slice(1); sendTemp(rid, `[info]🎯 [piconname:${sId}] 「${pl.choice==='chou'?'丁':'半'}」を選択！[/info]`); chkProg(rid); }
            }

            if (body.trim() === '/roll' && gambleActive && gSt[rid]?.type === 'cc' && gSt[rid].state === 'ACT') {
                let pl = gSt[rid].players.find(x => x.aid === sId);
                if (pl && !pl.res && sId !== gSt[rid].host) { pl.res = getRoll(); sendMsg(rid, `[info]🎲 [piconname:${sId}] の出目: ${pl.res.n}[/info]`); chkProg(rid); }
            }

            if ((body.trim() === '/hit' || body.trim() === '/stand') && gambleActive && gSt[rid]?.type === 'bj' && gSt[rid].state === 'ACT') {
                let g = gSt[rid], pl = g.players[g.turnIndex];
                if (pl && pl.aid === sId && pl.status === 'playing') {
                    if (body.trim() === '/hit') {
                        let c = g.deck.pop(); pl.hand.push(c); let sc = calcBj(pl.hand), hs = pl.hand.map(x=>x.s+x.r).join(' ');
                        if (sc > 21) { pl.status = 'bust'; await sendTemp(rid, `[info][piconname:${pl.aid}] ➡ ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n💥 バースト！[/info]`); g.turnIndex++; await nxBj(rid); } 
                        else if (sc === 21) { pl.status = 'stand'; await sendTemp(rid, `[info][piconname:${pl.aid}] ➡ ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n✨ 21到達！自動スタンド[/info]`); g.turnIndex++; await nxBj(rid); } 
                        else { await sendTemp(rid, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n\n👉 [code]/hit[/code] または [code]/stand[/code][/info]`); startTmr(rid); }
                    } else {
                        pl.status = 'stand'; await sendTemp(rid, `[info][piconname:${pl.aid}] スタンドしました。 (スコア: ${calcBj(pl.hand)})[/info]`); g.turnIndex++; await nxBj(rid);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

// --- BJ専用ヘルパー ---
const genDeck = () => {
    const s = ['♠','♥','♣','♦'], rk = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'], dk = [];
    for(let u of s) for(let k of rk) dk.push({ s:u, r:k, v:k==='A'?1:(['J','Q','K'].includes(k)?10:parseInt(k)) });
    for(let i=dk.length-1; i>0; i--) { const r=Math.floor(Math.random()*(i+1)); [dk[i],dk[r]]=[dk[r],dk[i]]; } return dk;
};
const calcBj = (h) => { let sc=0, a=0; for(let c of h){if(c.r==='A'){a++;sc+=11;}else sc+=c.v;} while(sc>21&&a>0){sc-=10;a--;} return sc; };

const nxBj = async (rid) => {
    let g = gSt[rid]; if (!g || g.type !== 'bj') return;
    while (g.turnIndex < g.players.length) {
        let pl = g.players[g.turnIndex]; if (pl.status !== 'playing') { g.turnIndex++; continue; }
        await sendTemp(rid, `[info][title]🃏 ターン進行[/title][piconname:${pl.aid}] さんの番です！\n手札: ${pl.hand.map(c=>c.s+c.r).join(' ')} (スコア: ${calcBj(pl.hand)})\n\n👉 [code]/hit[/code] または [code]/stand[/code][/info]`);
        startTmr(rid); return;
    }
    await resBj(rid);
};

const resBj = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.timeoutId);
    let dH = g.dealerHand, dS = 0, dA = 0;
    const updD = () => { dS=0; dA=0; for(let c of dH){if(c.r==='A'){dA++;dS+=11;}else dS+=c.v;} while(dS>21&&dA>0){dS-=10;dA--;} };
    updD(); let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラー 】\n伏せカードは ${dH[1].s}${dH[1].r} でした。\n`;
    while(dS < 17) { let c = g.deck.pop(); dH.push(c); updD(); msg += `➡ 引いた: ${c.s}${c.r}\n`; }
    msg += `最終手札: ${dH.map(c=>c.s+c.r).join(' ')} (スコア: ${dS})\n`; if (dS > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    for(let p of g.players) {
        let pS=0, pA=0; for(let c of p.hand){if(c.r==='A'){pA++;pS+=11;}else pS+=c.v;} while(pS>21&&pA>0){pS-=10;pA--;}
        let isM = await consumeMirai(p.aid); if(isM) { msg += `🌟 未来改変発動！\n`; p.status = 'bj'; pS = 21; dS = 22; }
        let rT = "", wA = 0;
        if(p.status==='bust') { rT = `💀 負け (バースト)`; await applyMasterTax(p.bet); }
        else if(p.status==='bj') { if(dS===21&&dH.length===2) { rT = `😐 引き分け`; await addMoney(p.aid, p.bet); } else { wA=Math.floor(p.bet*2.5); rT=`(cracker) 勝利(BJ) (+${fNum(wA)})`; await addMoney(p.aid, p.bet+wA); } }
        else { if(dS>21||pS>dS){ wA=p.bet*2; rT=`(cracker) 勝利 (+${fNum(wA)})`; await addMoney(p.aid, p.bet+wA); } else if(pS===dS){ rT=`😐 引き分け`; await addMoney(p.aid, p.bet); } else { rT=`💀 負け`; await applyMasterTax(p.bet); } }
        msg += `[piconname:${p.aid}]: スコア ${pS} ➡ ${rT}\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

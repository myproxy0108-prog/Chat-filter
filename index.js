const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client Init ---
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let isG = false, lRst = null; 
const spms = {}, gSt = {};

sb.from('config').select('value').eq('key', 'gamble_active').single().then(r => { if(r.data) isG = r.data.value === 'true'; }).catch(()=>{});

// --- Date Utils ---
const getT = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getM = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fN = n => Number(n).toLocaleString();

const vf = (req) => {
    const s = req.headers['x-chatworkwebhooksignature'];
    return s && s === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

// --- CW Messages ---
const mkRp = (a, r, m) => `[rp aid=${a} to=${r}-${m}]`;
const sendM = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const sendT = async (rid, txt, ms = 60000) => {
    try {
        const r = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (r?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${r.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- Money Logic ---
const addM = async (a, amt) => {
    const { data } = await sb.from('players').select('*').eq('account_id', a).single();
    let m = data ? data.money : 0, d = data ? (data.debt || 0) : 0;
    if (d > 0 && amt > 0) { let r = Math.min(d, amt); d -= r; amt -= r; }
    m += amt;
    if (data) await sb.from('players').update({ money: m, debt: d }).eq('account_id', a);
    else await sb.from('players').insert({ account_id: a, money: m, debt: d, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' });
};

// --- Admin & Defense ---
const isAd = async (rid, a) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === a.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kkTg = async (rid, aids, act = 'readonly') => {
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

const cSp = (a) => {
    const n = Date.now();
    if (!spms[a]) spms[a] = [];
    spms[a].push(n);
    spms[a] = spms[a].filter(t => n - t <= 5000);
    return (spms[a].length >= 10);
};

// --- Game Engine ---
const gDb = () => {
    let st = []; for(let i=0; i<6; i++) st.push(Math.random()*10+1);
    let cbs = [], tW = 0, mp = {}, s = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = st[i-1]*st[j-1]; cbs.push({c:`${i}-${j}`, w}); tW += w; } }
    cbs.forEach(c => { let o = (0.8/(c.w/tW)).toFixed(1); if(o<1.1)o=1.1; if(o>150)o=150.0; mp[c.c] = Number(o); });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : [code]${mp[k]}倍[/code]\n`; });
    return { mp, s, st };
};

const gCc = () => {
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

const gBj = () => {
    const s = ['♠','♥','♣','♦'], rk = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    let dk = [];
    for (let u of s) for (let r of rk) dk.push({ s: u, r: r, v: r==='A'?1:(['J','Q','K'].includes(r)?10:parseInt(r)) });
    for(let i = dk.length - 1; i > 0; i--) { const r = Math.floor(Math.random()*(i+1)); [dk[i], dk[r]] = [dk[r], dk[i]]; }
    return dk;
};
const cSc = (h) => { let sc=0, a=0; for (let c of h) { if(c.r==='A'){ a++; sc+=11; } else sc+=c.v; } while(sc>21&&a>0){ sc-=10; a--; } return sc; };

// --- ゲーム進行・タイマー ---
const cPg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'BET' && g.p.length >= 2 && g.p.every(p => p.b > 0)) {
        if (g.t === 'db') { clearTimeout(g.tid); if (g.rmI) clearTimeout(g.rmI); await rDb(rid); }
        else if (g.t === 'bj') {
            g.s = 'ACT'; g.dk = gBj(); g.dH = [g.dk.pop(), g.dk.pop()];
            let m = `[info][title]🃏 BJ 開始[/title]【 ディーラー 】\n🎴 ${g.dH[0].s}${g.dH[0].r} / [裏]\n[hr]`;
            for(let p of g.p) { p.h = [g.dk.pop(), g.dk.pop()]; let sc = cSc(p.h); m += `[piconname:${p.a}]: ${p.h.map(c=>c.s+c.r).join(' ')} (スコア:${sc})`; if(sc===21){ p.s='bj'; m+=` 🎉 BJ！\n`; } else { p.s='playing'; m+=`\n`; } }
            await sendT(rid, m+"[/info]", 120000); g.tn = 0; await nxBj(rid);
        } else {
            g.s = 'ACT';
            let txt = g.t === 'ch' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "全員 [code]/roll[/code] でサイコロを振ってください。";
            await sendT(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            sTmr(rid, 60000);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.every(p => p.c)) await rCh(rid);
        if (g.t === 'cc' && g.p.every(p => p.res)) await rCc(rid);
    }
};

const nxBj = async (rid) => {
    let g = gSt[rid]; if (!g || g.t !== 'bj') return;
    while (g.tn < g.p.length) {
        let p = g.p[g.tn]; if (p.s !== 'playing') { g.tn++; continue; }
        let sc = cSc(p.h), hs = p.h.map(c=>c.s+c.r).join(' ');
        await sendT(rid, `[info][title]🃏 ターン進行[/title][piconname:${p.a}] さんの番です！\n手札: ${hs} (スコア: ${sc})\n\n👉 [code]/hit[/code] (引く) または [code]/stand[/code] (引かない) を入力してください。\n(制限1分)[/info]`);
        sTmr(rid, 60000); return;
    }
    await rBj(rid);
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'REC') {
        if (g.p.length >= 2 || (g.t === 'bj' && g.p.length >= 1)) {
            g.s = 'BET';
            if (g.t === 'db') {
                let ex = `\n【 🐎 馬連オッズ 】\n${g.oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                sTmr(rid, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                sTmr(rid, 60000);
            }
        } else {
            await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gSt[rid] = null;
        }
    } else if (g.s === 'BET') {
        let kick = [], act = [];
        for (let p of g.p) { if (p.b === 0) { kick.push(p.a); } else act.push(p); }
        g.p = act;
        if (kick.length > 0) await sendT(rid, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        if (g.p.length < 2 && g.t !== 'bj') {
            for (let p of g.p) if (p.b > 0) await addM(p.a, p.b);
            await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gSt[rid] = null;
        } else if (g.p.length === 0 && g.t === 'bj') {
            await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]全員退出したため中止しました。[/info]`); gSt[rid] = null;
        } else await cPg(rid);
    } else if (g.s === 'ACT') {
        if (g.t === 'bj') {
            let p = g.p[g.tn];
            if (p && p.s === 'playing') {
                p.s = 'stand'; await sendT(rid, `[info]⏳ タイムアウトにより、[piconname:${p.a}] 様は自動スタンドしました。[/info]`);
                g.tn++; await nxBj(rid);
            }
        } else {
            let kick = [], act = [];
            for (let p of g.p) {
                if ((g.t === 'ch' && !p.c) || (g.t === 'cc' && !p.res)) { kick.push(p.a); if (p.b > 0) await addM(p.a, p.b); } else act.push(p);
            }
            g.p = act;
            if (kick.length > 0) await sendT(rid, `[info][title]⏳ タイムアウト[/title]時間切れのため退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
            if (g.p.length < 2) {
                for (let p of g.p) if (p.b > 0) await addM(p.a, p.b);
                await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止・返金しました。[/info]`);
                gSt[rid] = null;
            } else {
                if (g.t === 'ch') await rCh(rid); else if (g.t === 'cc') await rCc(rid);
            }
        }
    }
};

const sTmr = (rid, ms = 60000, isD = false) => {
    let g = gSt[rid]; if (!g) return;
    if (g.tid) clearTimeout(g.tid); if (g.rmI) clearTimeout(g.rmI);
    if (isD) g.rmI = setTimeout(() => { if (gSt[rid] && gSt[rid].s === 'BET') sendT(rid, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は [code]/bet [額] [馬番-馬番][/code] を入力してください。[/info]`); }, ms - 60000);
    g.tid = setTimeout(() => hTO(rid), ms);
};

// --- ゲーム結果精算 ---
const rCc = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pR = gCc(); // 親（Bot）が振る
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 (Bot) の出目 】\n[ ${pR.d.join(', ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let win = (r.r > pR.r) || (r.r === pR.r && r.s > pR.s), draw = (r.r === pR.r && r.s === pR.s);
        if (draw) { await addM(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
        else if (win) { let ml = r.m > 0 ? r.m : 1; await addM(p.a, p.b + (p.b * ml)); msg += `(cracker) [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fN(p.b * ml)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 負け...\n`; }
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const rCh = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, sum = d1 + d2, ans = (sum % 2 === 0) ? 'chou' : 'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${ans === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        if (p.c === ans) { await addM(p.a, p.b * 2); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fN(p.b * 2)} コイン)\n`; } 
        else { msg += `💀 [piconname:${p.a}]: 予想[${p.c === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; }
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const rDb = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid); if (g.rmI) clearTimeout(g.rmI);
    let st = g.st, ws = [...st], tW = ws.reduce((a, b) => a + b, 0), r1 = Math.random() * tW, s1 = 0, f = 1;
    for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ f = i+1; break; } }
    ws[f-1] = 0; tW = ws.reduce((a, b) => a + b, 0); let r2 = Math.random() * tW, s2 = 0, se = 1;
    for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ se = i+1; break; } }
    let wc = f < se ? `${f}-${se}` : `${se}-${f}`, od = g.oMp[wc];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${f} 】番と【 ${se} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${wc} 】 (${od}倍)\n[hr]【 プレイヤー結果 】\n`;
    for(let p of g.p){
        if(p.c === wc){ let wA = Math.floor(p.b * od); await addM(p.a, p.b + wA); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fN(wA)} コイン)\n`; } 
        else { msg += `💀 [piconname:${p.a}]: 予想[${p.c}] ➡ はずれ...\n`; }
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const rBj = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let dH = g.dH, dS = 0, dA = 0;
    const updD = () => { dS = 0; dA = 0; for (let c of dH) { if (c.r === 'A') { dA++; dS += 11; } else dS += c.v; } while (dS > 21 && dA > 0) { dS -= 10; dA--; } };
    updD();
    let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラーのターン 】\n伏せカードは ${dH[1].s}${dH[1].r} でした。\n`;
    while(dS < 17) { let c = g.dk.pop(); dH.push(c); updD(); msg += `➡ 引いたカード: ${c.s}${c.r}\n`; }
    msg += `最終手札: ${dH.map(c=>c.s+c.r).join(' ')} (スコア: ${dS})\n`; if (dS > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        let pS = cSc(p.h), wA = 0, rT = "";
        if (p.s === 'bust') { rT = `💀 負け (バースト)`; } 
        else if (p.s === 'bj') { if (dS === 21 && dH.length === 2) { rT = `😐 引き分け (BJ同士)`; await addM(p.a, p.b); } else { wA = Math.floor(p.b * 2.5); rT = `(cracker) 勝利！ (BJ: 配当2.5倍) (+${fN(wA)})`; await addM(p.a, p.b + wA); } } 
        else { if (dS > 21 || pS > dS) { wA = p.b * 2; rT = `🎉 勝利！ (+${fN(wA)})`; await addM(p.a, p.b + wA); } else if (pS === dS) { rT = `😐 引き分け (返金)`; await addM(p.a, p.b); } else { rT = `💀 負け`; } }
        msg += `[piconname:${p.a}]: スコア ${pS} ➡ ${rT}\n`;
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body.trim(), sId = ev.account_id.toString(), mId = ev.message_id;
    const td = getTodayStr(), tM = getThisMonthStr();

    (async () => {
        try {
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rA = rpM ? rpM[1] : null;

            // 1. ブラックリスト
            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            // 2. スパム
            if (checkSpam(sId) && !(await isUserAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTempMessage(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 3. 日付更新
            if (localLastResetDate !== td) {
                const { data: ld } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!ld || ld.value !== td) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: td });
                    localLastResetDate = td;
                    let m = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事制限がリセットされました！\n[hr]`;
                    const { data: tD } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tD ? JSON.parse(tD.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let pays = {}, ws = [];
                        const cP = (n, w) => {
                            if (n === w) return { p: 30000, n: '🥇 1等' };
                            let pr = w - 1 < 1 ? 9999 : w - 1, nx = w + 1 > 9999 ? 1 : w + 1;
                            if (n === pr || n === nx) return { p: 15000, n: '🥈 前後賞' };
                            if (n % 1000 === w % 1000) return { p: 10000, n: '🥈 2等' }; 
                            if (n % 100 === w % 100) return { p: 5000, n: '🥉 3等' };    
                            if (n % 10 === w % 10) return { p: 1000, n: '🏅 4等' };      
                            return null;
                        };
                        for (let t of tks) { let r = cP(t.num, win); if(r) { ws.push({ a: t.aid, num: t.num, ...r }); pays[t.aid] = (pays[t.aid] || 0) + r.p; } }
                        if (ws.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            ws.sort((a,b) => b.p - a.p); 
                            for (let w of ws.slice(0, 20)) m += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)} コイン)\n`;
                            if (ws.length > 20) m += `...他 ${ws.length - 20} 件の当選！\n`;
                        } else { m += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`; }
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMsg(rid, m + `[/info]`);
                }
            }

            // 4. データ取得 & サイレント仕事回復
            let { data: p } = await sb.from('players').select('*').eq('account_id', sId).single();
            if (!p && isGamble && !body.startsWith('/')) {
                await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン' });
                p = { money: 0, debt: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン' };
            }
            if (isGamble && p && !body.startsWith('/')) {
                let mc = (p.msg_count || 0) + 1, wl = p.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                await sb.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = p?p.money:0, myD = p?(p.debt||0):0, myJ = p?(p.job||'サラリーマン'):'サラリーマン', cDb = (p&&p.debt_month===tM)?(p.monthly_debt||0):0;

            // --- ヘルプ ---
            if (body === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (10分に1回, 1日5回上限)
・ [code]/catch[/code] または [code]/goal[/code] : 職業専用能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (1日5回)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/cc[/code] : チンチロリン募集 ([code]/roll[/code] でサイコロ)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬連][/code])
・ [code]/bj[/code] : ブラックジャック募集 ([code]/hit[/code] か [code]/stand[/code])

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : 進行中のゲームを強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効/無効化
・ [code]/blacklist[/code], [code]/remove-rank[/code] 等[/info]`;
                return sendTempMessage(rid, h, 120000);
            }

            // --- 👑 管理者 ---
            if (/(^|\n)\/take\b/.test(body) && isGamble && await isUserAdmin(rid, sId)) {
                let a = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (tg && a > 0) { await addMoney(tg, a); return sendTempMessage(rid, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${tg}] 様へ ${fNum(a)} コインを付与しました。[/info]`); }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && isGamble && await isUserAdmin(rid, sId)) {
                if (gSt[rid] && gSt[rid].s !== 'IDLE') {
                    for (let x of gSt[rid].p) { if (x.b > 0) await addMoney(x.a, x.b); }
                    clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt); gSt[rid] = null;
                    return sendTempMessage(rid, `[info][title]⚠️ 強制終了[/title]管理者がゲームを強制終了しました。\n(※賭け金は全額返還されました)[/info]`);
                } else return sendTempMessage(rid, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!tg && cmd !== 'add') return; if (!tg && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i => i !== tg); sendTempMessage(rid, `[info][title]設定完了[/title][piconname:${tg}] 様のランキング除外を解除しました。[/info]`); }
                    else { ex.push(tg); sendTempMessage(rid, `[info][title]設定完了[/title][piconname:${tg}] 様をランキングから除外しました。[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await sb.from('blacklist').insert({account_id: tg}); await kickTarget(rid, [tg], 'readonly'); return sendTempMessage(rid, `[info][title]🚫 追放完了[/title][piconname:${tg}] をBL登録し、閲覧のみに変更しました。[/info]`); }
                else if (cmd === 'remove') { await sb.from('blacklist').delete().eq('account_id', tg); return sendTempMessage(rid, `[info][title]✅ 解除完了[/title][piconname:${tg}] の追放状態を解除しました。[/info]`); }
                else if (cmd === 'list') { const { data: ls } = await sb.from('blacklist').select('account_id'); const s = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし"; return sendTempMessage(rid, `[info][title]📜 ブラックリスト一覧[/title]${s}\n[hr]※1分後に自動消滅します[/info]`); }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(rid, sId)) { isGamble = true; await sb.from('config').upsert({key:'gamble_active', value:'true'}); return sendMsg(rid, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); }
            if (body.startsWith('/fi-gya') && await isUserAdmin(rid, sId)) { isGamble = false; await sb.from('config').upsert({key:'gamble_active', value:'false'}); return sendMsg(rid, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); }

            // --- ⛩️ おみくじ ---
            if (body === '/omikuji' && isGamble) {
                if (p?.omikuji_date === today) return sendTempMessage(rid, `[info][title]⚠️ おみくじ[/title]${mkRp(sId, rid, mId)}\n本日のおみくじは既に引いています。\n(結果: ${p.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通りです。"; } else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通りです。"; } else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                await sb.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                return sendMsg(rid, `[info][title]⛩️ おみくじ結果[/title]${mkRp(sId, rid, mId)}\n[hr]今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && isGamble) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (cDb + a > 5000) return sendTempMessage(rid, `[info][title]⚠️ 借金上限エラー[/title]${mkRp(sId, rid, mId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${cDb} コイン借りています)[/info]`);
                    if (p) await sb.from('players').update({ money: myM + a, debt: myD + a, monthly_debt: cDb + a, debt_month: tM }).eq('account_id', sId);
                    else await sb.from('players').insert({ account_id: sId, money: a, debt: a, monthly_debt: a, debt_month: tM });
                    return sendTempMessage(rid, `[info][title]💳 お借り入れ完了[/title][piconname:${sId}] 様\n${fNum(a)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (cDb + a))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && isGamble) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, myM - myD); if (av < a) return sendTempMessage(rid, `[info][title]⚠️ 送金エラー[/title]${mkRp(sId, rid, mId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${fNum(av)} コインのみです)[/info]`);
                    let tx = Math.floor(a * 0.10); let rA = a - tx;
                    await sb.from('players').update({ money: myM - a }).eq('account_id', sId);
                    const { data: rc } = await sb.from('players').select('*').eq('account_id', tg).single();
                    if (rc) await sb.from('players').update({ money: rc.money + rA }).eq('account_id', tg);
                    else await sb.from('players').insert({ account_id: tg, money: rA, debt: 0 });
                    return sendTempMessage(rid, `[info][title]🎁 送金完了[/title][piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(a)} コインを送金しました。\n[hr]※システム税 10% (${fNum(tx)} コイン) が引かれ、相手には ${fNum(rA)} コインが届きました。[/info]`);
                }
            }

            if (body === '/status') {
                const rem = Math.max(0, 5 - (p?p.slot_count:0));
                const dStr = myD > 0 ? `\n💳 借金: -${fNum(myD)} コイン` : '';
                return sendTempMessage(rid, `[info][title]📊 プレイヤー情報[/title][piconname:${sId}] 様\n\n💰 所持金: ${fNum(myM)} コイン${dStr}\n💎 純資産: ${fNum(myM - myD)} コイン\n[hr]👔 職業: ${myJ}\n🎰 スロット残り: ${rem} 回\n💼 お仕事残り: ${p?p.work_limit:0} 回\n⛩️ 今日の運勢: ${p?.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
            }

            if (body === '/money-rank') {
                const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single(); let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await sb.from('players').select('*'); let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(net)} コイン ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTempMessage(rid, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const jM = body.match(/^\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (jM && isGamble) {
                const jn = jM[1]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJ === jn) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nすでに ${jn} に就いています！[/info]`);
                if (myM < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${mkRp(sId, rid, mId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                await sb.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                return sendTempMessage(rid, `[info][title]🎉 転職完了[/title][piconname:${sId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            } else if (body === '/job' && isGamble) {
                return sendTempMessage(rid, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)
 ▶ [code]/work[/code] (100〜500) ※10%でミス0

🏛️ 公務員 (費用: 2000)
 ▶ [code]/work[/code] (300〜500)

🚓 警察官 (費用: 3000)
 ▶ [code]/work[/code] (300〜700)
 ▶ [code]/catch[/code] (30%の確率で犯人逮捕! 800)

⚽ プロスポーツ選手 (費用: 5000)
 ▶ [code]/work[/code] (500〜1000)
 ▶ [code]/goal[/code] (30%の確率でゴール! 1000)
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (body === '/work' && isGamble && p) {
                if (p.work_limit <= 0) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (p.last_work_time || 0) < 600000) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                let e = 0, m = "";
                if(myJ === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で大きなミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJ === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJ === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJ === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${fNum(e)} コイン稼ぎました！⚽`; }
                await sb.from('players').update({ last_work_time: Date.now(), work_limit: p.work_limit - 1 }).eq('account_id', sId);
                await addMoney(sId, e); return sendTempMessage(rid, `[info][title]💼 お仕事完了[/title][piconname:${sId}]\n${m}\n(残り ${p.work_limit - 1} 回)[/info]`);
            }

            if ((body === '/catch' || body === '/goal') && isGamble && p) {
                let iC = body === '/catch';
                if (iC && myJ !== '警察官') return sendTempMessage(rid, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (!iC && myJ !== 'プロスポーツ選手') return sendTempMessage(roomId, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (p.skill_date === today) return sendTempMessage(rid, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){ e=800; m=`見事犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; } else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){ e=1000; m=`スーパーゴールを決めました！スポンサーから ${e} コイン獲得！🥅✨`; } else m=`シュートは外れてしまいました...🤦‍♂️`; }
                await sb.from('players').update({ skill_date: today }).eq('account_id', sId);
                await addMoney(sId, e); return sendTempMessage(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && isGamble && p) {
                if (p.slot_count >= 5) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のスロットは上限(1日5回)に達しました！[/info]`);
                if (Date.now() - Number(p.last_slot_time || 0) < 600000) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nスロット休憩中(10分間隔)です！[/info]`);
                let b = sM[2] === 'max' ? myM : (sM[2] === 'half' ? Math.floor(myM / 2) : parseInt(sM[2], 10));
                if (b > 0 && myM >= b) {
                    await sb.from('players').update({ money: myM - b, slot_count: p.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', sId);
                    let r = Math.random() * 100, omi = (p.omikuji_date === today) ? p.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    let wA = b * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendMsg(rid, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(b)} ➡ 獲得: ${fNum(wA)} コイン\n(残り回数: ${5 - (p.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && isGamble) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myM < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ let s = ((rs+i) % (10000-cnt)) + 1; let ok = true; for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } if(ok){ st=s; break; } }
                        if(st === -1) return sendTempMessage(roomId, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(roomId, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN = av.slice(0, cnt);
                    }
                    await supabase.from('players').update({ money: myM - cost }).eq('account_id', sId);
                    for (let n of mN) tks.push({ aid: sId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 ゲーム共通 (募集・参加・開始・退出・進行) ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby|bj)\b/) && isGamble) {
                if (gSt[rid]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                let t = body.includes('/derby') ? 'db' : (body.includes('/cc') ? 'cc' : (body.includes('/bj') ? 'bj' : 'ch'));
                gSt[rid] = { type: t, s: 'REC', h: sId, p: [{ a: sId, b: 0 }] };
                
                let tN = t==='db' ? "🐎 みんなでダービー" : (t==='cc' ? "🎲 チンチロリン" : (t==='bj' ? "🃏 ブラックジャック" : "🎲 丁半ゲーム")); 
                let ex = t==='db' ? "[code]/join derby[/code]" : (t==='cc' ? "[code]/join cc[/code]" : (t==='bj' ? "[code]/join bj[/code]" : "[code]/join chouhan[/code]"));
                
                if (t === 'db') { let dO = genDerby(); gSt[rid].oMp = dO.mp; gSt[rid].oS = dO.s; gSt[rid].st = dO.st; }
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${sId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※1分経過で自動進行します。[/info]`); 
                startTmr(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby|bj)/) && isGamble && gSt[rid]?.s === 'REC') {
                if (!gSt[rid].p.find(x => x.a === sId)) { gSt[rid].p.push({ a: sId, b: 0 }); sendMsg(roomId, `[info]🙋‍♂️ [piconname:${sId}] が参加しました！ (現在 ${gSt[rid].p.length}人)[/info]`); }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby|bj)/) && isGamble && gSt[rid]?.s === 'REC' && gSt[rid].h === sId) {
                if (gSt[rid].p.length < 2 && gSt[rid].type !== 'bj') return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gSt[rid].tid); handleTO(rid); return;
            }

            if (body === '/leave' && isGamble && gSt[rid]) {
                let idx = gSt[rid].p.findIndex(p => p.a === sId);
                if (idx !== -1) {
                    let cp = gSt[rid].p[idx]; gSt[rid].p.splice(idx, 1);
                    if (cp.b > 0) await addMoney(sId, cp.b); // 返金
                    sendTempMessage(roomId, `[info]🚪 [piconname:${sId}] が退出しました。[/info]`);
                    if (gSt[rid].p.length === 0) { clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt); gSt[rid] = null; return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); }
                    chkProg(rid);
                }
                return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && isGamble && gSt[rid]?.s === 'BET') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && pl.b === 0) {
                    let b = bM[2] === 'max' ? myM : (bM[2] === 'half' ? Math.floor(myM/2) : parseInt(bM[2], 10));
                    if (b > 0 && myM >= b) {
                        if (gSt[rid].type === 'db') {
                            let h = bM[3]; if (!h || !gSt[rid].oMp[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            pl.c = h;
                        }
                        pl.b = b; await supabase.from('players').update({ money: myM - b }).eq('account_id', sId);
                        sendTempMessage(roomId, `[info]💰 [piconname:${sId}] ${fNum(b)} コインをベットしました！[/info]`); chkProg(rid);
                    } else sendTempMessage(roomId, `[info]⚠️ ${mkRp(sId, roomId, mId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body === '/chou' || body === '/han') && isGamble && gSt[rid]?.type === 'ch' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.c) { pl.c = body.slice(1); sendTempMessage(roomId, `[info]🎯 [piconname:${sId}] 「${pl.c==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); chkProg(rid); }
            }

            if (body === '/roll' && isGamble && gSt[rid]?.type === 'cc' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.res && sId !== gSt[rid].h) { pl.res = getRoll(); sendMsg(roomId, `[info]🎲 [piconname:${sId}] の出目: ${pl.res.n}[/info]`); chkProg(rid); }
            }

            if ((body === '/hit' || body === '/stand') && isGamble && gSt[rid]?.type === 'bj' && gSt[rid].s === 'ACT') {
                let g = gSt[rid], pl = g.p[g.tn];
                if (pl && pl.a === sId && pl.st === 'playing') {
                    if (body === '/hit') {
                        let c = g.dk.pop(); pl.h.push(c);
                        let sc = 0, a = 0; for(let x of pl.h){ if(x.r==='A'){a++; sc+=11;}else sc+=x.v; } while(sc>21&&a>0){sc-=10;a--;}
                        let hs = pl.h.map(x=>x.s+x.r).join(' ');
                        if (sc > 21) { pl.st = 'bust'; await sendTempMessage(roomId, `[info][piconname:${pl.a}] ➡ ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n💥 バースト！[/info]`); g.tn++; await nxBj(rid); } 
                        else if (sc === 21) { pl.st = 'stand'; await sendTempMessage(roomId, `[info][piconname:${pl.a}] ➡ ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n✨ 21到達！自動スタンドします。[/info]`); g.tn++; await nxBj(rid); } 
                        else { await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.a}]\n引いたカード: ${c.s}${c.r}\n手札: ${hs} (スコア: ${sc})\n\n👉 [code]/hit[/code] または [code]/stand[/code][/info]`); startTmr(rid); }
                    } else {
                        pl.st = 'stand'; let sc=0,a=0; for(let x of pl.h){if(x.r==='A'){a++;sc+=11;}else sc+=x.v;} while(sc>21&&a>0){sc-=10;a--;}
                        await sendTempMessage(roomId, `[info][piconname:${pl.a}] スタンドしました。 (スコア: ${sc})[/info]`); g.tn++; await nxBj(rid);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

// --- BJ Helpers (後半の最後に配置) ---
const gBj = () => {
    const s = ['♠','♥','♣','♦'], r = ['A','2','3','4','5','6','7','8','9','10','J','Q','K']; let dk = [];
    for(let u of s) for(let k of r) dk.push({ s:u, r:k, v:k==='A'?1:(['J','Q','K'].includes(k)?10:parseInt(k)) });
    for(let i = dk.length-1; i>0; i--) { const rnd = Math.floor(Math.random()*(i+1)); [dk[i], dk[rnd]] = [dk[rnd], dk[i]]; } return dk;
};
const nxBj = async (rid) => {
    let g = gSt[rid]; if (!g || g.t !== 'bj') return;
    while (g.tn < g.p.length) {
        let pl = g.p[g.tn]; if (pl.st !== 'playing') { g.tn++; continue; }
        let sc=0,a=0; for(let x of pl.h){if(x.r==='A'){a++;sc+=11;}else sc+=x.v;} while(sc>21&&a>0){sc-=10;a--;}
        let hs = pl.h.map(c=>c.s+c.r).join(' ');
        await sendTempMessage(rid, `[info][title]🃏 ターン進行[/title][piconname:${pl.a}] さんの番です！\n手札: ${hs} (スコア: ${sc})\n\n👉 [code]/hit[/code] (引く) または [code]/stand[/code] (引かない) を入力してください。\n(制限1分)[/info]`);
        startTmr(rid); return;
    }
    await resBj(rid);
};
const resBj = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let dH = g.dH, dS = 0, dA = 0;
    const updD = () => { dS = 0; dA = 0; for(let c of dH){ if(c.r==='A'){dA++;dS+=11;}else dS+=c.v;} while(dS>21&&dA>0){dS-=10;dA--;} };
    updD(); let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラーのターン 】\n伏せカードは ${dH[1].s}${dH[1].r} でした。\n`;
    while(dS < 17) { let c = g.dk.pop(); dH.push(c); updD(); msg += `➡ 引いたカード: ${c.s}${c.r}\n`; }
    msg += `最終手札: ${dH.map(c=>c.s+c.r).join(' ')} (スコア: ${dS})\n`; if (dS > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    for(let p of g.p) {
        let pS=0, pA=0; for(let c of p.h){if(c.r==='A'){pA++;pS+=11;}else pS+=c.v;} while(pS>21&&pA>0){pS-=10;pA--;}
        let rT = "", wA = 0;
        if(p.st==='bust') rT = `💀 負け (バースト)`;
        else if(p.st==='bj') { if(dS===21&&dH.length===2) { rT = `😐 引き分け (BJ同士)`; await addMoney(p.a, p.b); } else { wA=Math.floor(p.b*2.5); rT=`(cracker) 勝利！ (BJ2.5倍) (+${fNum(wA)})`; await addMoney(p.a, p.b+wA); } }
        else { if(dS>21||pS>dS){ wA=p.b*2; rT=`🎉 勝利！ (+${fNum(wA)})`; await addMoney(p.a, p.b+wA); } else if(pS===dS){ rT=`😐 引き分け (返金)`; await addMoney(p.a, p.b); } else rT=`💀 負け`; }
        msg += `[piconname:${p.a}]: スコア ${pS} ➡ ${rT}\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

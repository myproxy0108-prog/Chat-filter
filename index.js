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
let isGamble = false;
let localLastReset = null;
const spams = {};
const gSt = {}; // ゲーム状態管理

let betLogs = [];   // タイムトラベル(/KK)用の過去5分ログ
let cmState = null; // マスター(/cm)の吸収状態 { a: aid, e: expire }
let mkState = null; // タイムトラベラー(/MK)のイカサマ状態 { a: aid }

sb.from('config').select('value').eq('key', 'gamble_active').maybeSingle().then(r => {
    if (r.data) isGamble = r.data.value === 'true';
}).catch(()=>{});

// --- Utils ---
const getToday = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getMonth = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySig = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const exp = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === exp;
};

const mkRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendM = async (rid, txt) => { try { await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`); } catch(e){} };
const sendT = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- Money & Logs ---
const logBet = (aid, diff) => {
    if (diff === 0) return;
    betLogs.push({ a: aid, d: diff, t: Date.now() });
    betLogs = betLogs.filter(l => Date.now() - l.t <= 300000); // 過去5分のみ保持
};

const addMoney = async (aid, amount) => {
    const { data } = await sb.from('players').select('*').eq('account_id', aid).maybeSingle();
    let money = data ? data.money : 0, debt = data ? (data.debt || 0) : 0, actualDiff = amount;

    if (debt > 0 && amount > 0) {
        let r = Math.min(debt, amount);
        debt -= r; amount -= r;
    }
    money += amount;

    if (data) await sb.from('players').update({ money, debt }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money, debt, slot_count: 0, work_limit: 5, msg_count: 0, slot_limit: 5, job: 'サラリーマン' });
    logBet(aid, actualDiff);
};

const applyCM = async (lossAmt) => {
    if (cmState && Date.now() < cmState.e && lossAmt > 0) {
        let ab = Math.floor(lossAmt * 0.5);
        if (ab > 0) await addMoney(cmState.a, ab);
    }
};

// --- Defense ---
const isAd = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTarget = async (rid, targetAids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`);
        let ad = c.filter(m=>m.role==='admin'||m.role==='creator').map(m=>m.account_id.toString());
        let me = c.filter(m=>m.role==='member').map(m=>m.account_id.toString());
        let ro = c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let f = false;
        for (let a of targetAids) {
            let id = a.toString();
            if (ad.includes(id) || me.includes(id) || ro.includes(id)) {
                f = true; ad = ad.filter(x=>x!==id); me = me.filter(x=>x!==id); ro = ro.filter(x=>x!==id);
                if (act === 'readonly') ro.push(id);
            }
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
    const now = Date.now();
    if (!spams[aid]) spams[aid] = [];
    spams[aid].push(now);
    spams[aid] = spams[aid].filter(t => now - t <= 5000);
    return (spams[aid].length >= 10);
};

// --- Games ---
const genDerby = () => {
    let st = []; for(let i=0; i<6; i++) st.push(Math.random() * 10 + 1);
    let cb = [], tW = 0, mp = {}, s = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = st[i-1]*st[j-1]; cb.push({ c: `${i}-${j}`, w }); tW += w; } }
    cb.forEach(c => { let o = (0.8 / (c.w / tW)).toFixed(1); if (o < 1.1) o = 1.1; if (o > 150) o = 150.0; mp[c.c] = Number(o); });
    Object.keys(mp).sort((a,b) => mp[a] - mp[b]).forEach(k => { s += `🐎 ${k} : [code]${mp[k]}倍[/code]\n`; });
    return { mp, s, st };
};

const getRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0]===1 && d[1]===1 && d[2]===1) return { d, n: "ピンゾロ", r: 6, s: 1, m: 5 };
        if (d[0]===d[1] && d[1]===d[2]) return { d, n: `${d[0]}の嵐`, r: 5, s: d[0], m: 3 };
        if (d[0]===4 && d[1]===5 && d[2]===6) return { d, n: "シゴロ", r: 4, s: 6, m: 2 };
        if (d[0]===1 && d[1]===2 && d[2]===3) return { d, n: "ヒフミ", r: 0, s: 0, m: -2 };
        if (d[0]===d[1]) return { d, n: `${d[2]}の目`, r: 2, s: d[2], m: 1 };
        if (d[1]===d[2]) return { d, n: `${d[0]}の目`, r: 2, s: d[0], m: 1 };
        if (d[0]===d[2]) return { d, n: `${d[1]}の目`, r: 2, s: d[1], m: 1 };
    }
    return { d: [0,0,0], n: "目なし", r: 1, s: 0, m: 1 };
};

const startTmr = (rid, ms = 60000, rem = false) => {
    let g = gSt[rid]; if (!g) return;
    if (g.tid) clearTimeout(g.tid); if (g.rmT) clearTimeout(g.rmT);
    
    if (rem) g.rmT = setTimeout(() => {
        if (gSt[rid] && gSt[rid].s === 'BET') sendT(rid, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は [code]/bet [額] [馬1-馬2][/code] を入力してください。[/info]`);
    }, ms - 60000);
    g.tid = setTimeout(() => hTO(rid), ms);
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;

    if (g.s === 'BET' && g.p.length >= 2 && g.p.every(p => p.b > 0)) {
        if (g.t === 'db') {
            clearTimeout(g.tid); if (g.rmT) clearTimeout(g.rmT); await resDb(rid);
        } else {
            g.s = 'ACT';
            let txt = g.t === 'ch' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "親以外は [code]/roll[/code] でサイコロを振ってください。";
            await sendT(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startTmr(rid, 60000);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.length >= 2 && g.p.every(p => p.c)) await resCh(rid);
        if (g.t === 'cc' && g.p.length >= 2 && g.p.filter(x => x.a !== g.h).every(p => p.res)) await resCc(rid);
    }
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;

    if (g.s === 'REC') {
        if (g.p.length >= 2) {
            g.s = 'BET';
            if (g.t === 'db') {
                let ex = `\n【 🐎 馬連オッズ 】\n${g.oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分で通知します)[/info]`, 120000);
                startTmr(rid, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。/bet max や /bet half も可)[/info]`);
                startTmr(rid, 60000);
            }
        } else {
            await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gSt[rid] = null;
        }
    } else {
        let kick = [], act = [];
        for (let p of g.p) {
            let isK = false;
            if (g.s === 'BET' && p.b === 0) isK = true;
            if (g.s === 'ACT' && (g.t === 'ch' && !p.c || g.t === 'cc' && !p.res && p.a !== g.h)) isK = true;
            
            if (isK) { kick.push(p.a); if (p.b > 0) await addMoney(p.a, p.b); } 
            else { act.push(p); }
        }
        g.p = act;
        
        if (kick.length > 0) await sendT(rid, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kick.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        
        if (g.p.length < 2) {
            for (let p of g.p) if (p.b > 0) await addMoney(p.a, p.b);
            await sendT(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gSt[rid] = null;
        } else await chkProg(rid);
    }
};

const resCc = async (rid) => {
    let g = gSt[rid]; if (!g) return;
    try {
        clearTimeout(g.tid);
        let pR = getRoll(); 
        
        if (mkState && Math.random() < 0.8) {
            let mkP = g.p.find(p => p.a === mkState.a);
            if (mkP) { if (mkP.a === g.h) pR = { d: [1,1,1], n: "ピンゾロ", r: 6, s: 1, m: 5 }; else mkP.res = { d: [1,1,1], n: "ピンゾロ", r: 6, s: 1, m: 5 }; }
            mkState = null;
        }

        let m = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${g.h}]) の出目 】\n[ ${pR.d.join(', ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
        for (let p of g.p) {
            if (p.a === g.h) continue;
            let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
            let win = (r.r > pR.r) || (r.r === pR.r && r.s > pR.s), drw = (r.r === pR.r && r.s === pR.s);
            if (draw) { await addMoney(p.a, p.b); m += `😐 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
            else if (win) { let ml = r.m > 0 ? r.m : 1; await addMoney(p.a, p.b + (p.b * ml)); m += `(cracker) [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.b * ml)})\n`; }
            else { m += `💀 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 負け...\n`; await applyCM(p.b); }
        }
        await sendM(rid, m + "[/info]"); 
    } catch(e){} finally { gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() }); }
};

const resCh = async (rid) => {
    let g = gSt[rid]; if (!g) return;
    try {
        clearTimeout(g.tid);
        let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, sum = d1 + d2, res = (sum % 2 === 0) ? 'chou' : 'han';
        
        if (mkState && Math.random() < 0.8) {
            let mkP = g.p.find(p => p.a === mkState.a);
            if (mkP && mkP.choice) { res = mkP.choice; if (res === 'chou') { d1=2; d2=2; sum=4; } else { d1=1; d2=2; sum=3; } }
            mkState = null;
        }

        let m = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${res === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
        for (let p of g.p) {
            if (p.c === res) { await addMoney(p.a, p.b * 2); m += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(p.b * 2)} コイン)\n`; } 
            else { m += `💀 [piconname:${p.a}]: 予想[${p.c === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; await applyCM(p.b); }
        }
        await sendM(rid, m + "[/info]"); 
    } catch(e){} finally { gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() }); }
};

const resDb = async (rid) => {
    let g = gSt[rid]; if (!g) return;
    try {
        clearTimeout(g.tid); if (g.rmT) clearTimeout(g.rmT);
        let st = g.st, ws = [...st], tW = ws.reduce((a, b) => a + b, 0), r1 = Math.random() * tW, s1 = 0, f = 1;
        for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ f = i+1; break; } }
        ws[f-1] = 0; tW = ws.reduce((a, b) => a + b, 0); let r2 = Math.random() * tW, s2 = 0, s = 1;
        for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ s = i+1; break; } }
        
        let winC = f < s ? `${f}-${s}` : `${s}-${f}`;
        if (mkState && Math.random() < 0.8) {
            let mkP = g.p.find(p => p.a === mkState.a);
            if (mkP && mkP.c) { winC = mkP.c; let pts = winC.split('-'); f = parseInt(pts[0]); s = parseInt(pts[1]); }
            mkState = null;
        }

        let odd = g.oMp[winC], m = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${f} 】番と【 ${s} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winC} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
        for(let p of g.p){
            if(p.c === winC){ let w = Math.floor(p.b * odd); await addMoney(p.a, p.b + w); m += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(w)} コイン)\n`; } 
            else { m += `💀 [piconname:${p.a}]: 予想[${p.c}] ➡ はずれ...\n`; await applyCM(p.b); }
        }
        await sendM(rid, m + "[/info]"); 
    } catch(e){} finally { gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() }); }
};

// --- Webhook ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || ev.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getTodayStr(), tMonth = getThisMonthStr();

    (async () => {
        try {
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // 1. BL防衛
            const { data: isB } = await supabase.from('blacklist').select('*').eq('account_id', sId).maybeSingle();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            // 2. スパム防衛
            if (checkSpam(sId) && !(await isUserAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTempMessage(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 3. 深夜0時リセット & 宝くじ抽選
            if (localLastResetDate !== today) {
                const { data: cD } = await supabase.from('config').select('value').eq('key', 'last_reset_date').maybeSingle();
                if (!cD || cD.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null, slot_limit: 5 }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    let m = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事・能力制限がリセットされました！\n[hr]`;
                    
                    const { data: tD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').maybeSingle();
                    let tks = tD ? JSON.parse(tD.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let pays = {}, wns = [];
                        const chP = (n, w) => {
                            if(n===w) return { p:30000, n:'🥇 1等' }; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return { p:15000, n:'🥈 前後賞' };
                            if(n%1000===w%1000) return { p:10000, n:'🥈 2等' }; if(n%100===w%100) return { p:5000, n:'🥉 3等' };    
                            if(n%10===w%10) return { p:1000, n:'🏅 4等' }; return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r){ wns.push({a:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (wns.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            wns.sort((a,b)=>b.p-a.p); for (let w of wns.slice(0, 20)) m += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)} コイン)\n`;
                            if (wns.length>20) m += `...他 ${wns.length-20} 件の当選！\n`;
                        } else m += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendM(rid, m + `[/info]`);
                }
            }

            // 4. データ取得 & サイレント仕事回復
            let { data: pl } = await supabase.from('players').select('*').eq('account_id', sId).maybeSingle();
            if (!pl) {
                pl = { account_id: sId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 1, slot_limit: 5, job: 'サラリーマン' };
                await supabase.from('players').insert(pl);
            } else if (gambleActive && !body.startsWith('/')) {
                let mc = (pl.msg_count || 0) + 1, wl = pl.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = pl.money, myD = pl.debt || 0, myJ = pl.job || 'サラリーマン', cDb = (pl.debt_month === tMonth) ? (pl.monthly_debt || 0) : 0, mSL = pl.slot_limit || 5;

            // --- ヘルプ ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (10分に1回, 1日5回上限)
・ [code]/catch[/code], [code]/goal[/code], [code]/cm[/code], [code]/slot-up[/code], [code]/KK[/code], [code]/MK[/code] : 職業専用能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (2分間隔、上限99,999)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/cc[/code] : チンチロリン募集 ([code]/roll[/code] でサイコロ)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬連][/code])
※放置用: [code]/leave[/code] または [code]/fi-game[/code]

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : 強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code], [code]/blacklist[/code], [code]/remove-rank[/code][/info]`;
                return sendTempMessage(rid, h, 120000);
            }

            // --- 👑 管理者 ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (tg && amt > 0) { await addMoney(tg, amt); return sendTempMessage(rid, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${tg}] 様へ ${fNum(amt)} コインを付与しました。[/info]`); }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                if (gSt[rid] && gSt[rid].s !== 'IDLE') {
                    for (let p of gSt[rid].p) if (p.b > 0) await addMoney(p.a, p.b);
                    clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt);
                    gSt[rid] = null; return sendTempMessage(rid, `[info]⚠️ 管理者により進行中のゲームが強制終了・全額返金されました。[/info]`);
                } else return sendTempMessage(rid, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!tg && cmd !== 'add') return; if (!tg && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').maybeSingle();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i=>i!==tg); sendTempMessage(rid, `[info][title]設定完了[/title][piconname:${tg}] 様のランキング除外を解除しました。[/info]`); }
                    else { ex.push(tg); sendTempMessage(rid, `[info][title]設定完了[/title][piconname:${tg}] 様をランキングから除外しました。[/info]`); }
                    return await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await supabase.from('blacklist').insert({account_id:tg}); await kickTarget(rid,[tg],'readonly'); return sendTempMessage(rid, `[info][title]🚫 追放完了[/title][piconname:${tg}] をBL登録し閲覧のみに変更しました。[/info]`); }
                else if (cmd === 'remove') { await supabase.from('blacklist').delete().eq('account_id',tg); return sendTempMessage(rid, `[info][title]✅ 解除完了[/title][piconname:${tg}] のBLを解除しました。[/info]`); }
                else if (cmd === 'list') { const { data: ls } = await supabase.from('blacklist').select('account_id'); const str = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし"; return sendTempMessage(rid, `[info][title]📜 ブラックリスト一覧[/title]${str}\n[hr]※1分後に自動消滅します[/info]`); }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(rid, sId)) { gambleActive=true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); return sendM(rid, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); }
            if (body.startsWith('/fi-gya') && await isUserAdmin(rid, sId)) { gambleActive=false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); return sendM(rid, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (pl && pl.omikuji_date === today) return sendTempMessage(rid, `[info][title]⚠️ おみくじ[/title]${mkRp(sId, rid, mId)}\n本日のおみくじは既に引いています。\n(結果: ${pl.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r<10) { res="大吉"; eff="(cracker) スロット確率が【大幅UP (0.5%)】！"; } else if(r<30) { res="中吉"; eff="(cracker) スロット確率が【少しUP (0.3%)】！"; } else if(r<60) { res="小吉"; eff="🎯 スロット確率は通常通り(0.1%)です。"; } else if(r<85) { res="吉"; eff="🎯 スロット確率は通常通り(0.1%)です。"; } else if(r<95) { res="凶"; eff="💧 スロット確率が【少しDOWN】..."; } else { res="大凶"; eff="💀 スロット確率が【大幅DOWN (0.01%)】..."; }
                await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                return sendM(rid, `[info][title]⛩️ おみくじ結果[/title]${mkRp(sId, rid, mId)}\n[hr]今日の運勢は...【 ${res} 】！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 (借金・送金) ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && gambleActive) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (cDb + a > 5000) return sendTempMessage(rid, `[info][title]⚠️ 借金上限エラー[/title]${mkRp(sId, rid, mId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${cDb} コイン借りています)[/info]`);
                    await supabase.from('players').update({ money: myM + a, debt: myD + a, monthly_debt: cDb + a, debt_month: tMonth }).eq('account_id', sId);
                    return sendTempMessage(rid, `[info][title]💳 お借り入れ完了[/title][piconname:${sId}] 様\n${fNum(a)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (cDb + a))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, myM - myD); 
                    if (av < a) return sendTempMessage(rid, `[info][title]⚠️ 送金エラー[/title]${mkRp(sId, rid, mId)}\n送金枠(純資産)が不足しています！\n(送金可能額: ${fNum(av)} コイン)[/info]`);
                    let tx = Math.floor(a * 0.10); let rA = a - tx;
                    await supabase.from('players').update({ money: myM - a }).eq('account_id', sId);
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', tg).maybeSingle();
                    if (rc) await supabase.from('players').update({ money: rc.money + rA }).eq('account_id', tg);
                    else await supabase.from('players').insert({ account_id: tg, money: rA, debt: 0 });
                    return sendTempMessage(rid, `[info][title]🎁 送金完了[/title][piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(a)} コインを送金しました。\n[hr]※システム税 10% (${fNum(tx)} コイン) が引かれ、相手には ${fNum(rA)} コインが届きました。[/info]`);
                }
            }

            // --- 📊 ステータス & ランキング ---
            if (body.trim() === '/status') {
                const rS = Math.max(0, mSL - pl.slot_count);
                const dS = myD > 0 ? `\n💳 借金: -${fNum(myD)} コイン` : '';
                return sendTempMessage(rid, `[info][title]📊 プレイヤー情報[/title][piconname:${sId}] 様\n\n💰 所持金: ${fNum(myM)} コイン${dS}\n💎 純資産: ${fNum(myM - myD)} コイン\n[hr]👔 職業: ${myJ}\n🎰 スロット残り: ${rS} 回\n💼 お仕事残り: ${pl.work_limit} 回\n⛩️ 今日の運勢: ${pl.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').maybeSingle(); 
                let ex = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !ex.includes(d.account_id)) : [];
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let n = (d.money||0) - (d.debt||0); let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(n)} コイン ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTempMessage(rid, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const cJM = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
            if (cJM && gambleActive) {
                const jn = cJM[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, '賭博師': 100000, 'マスター': 700000, 'タイムトラベラー': 1000000};
                if (myJ === jn) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nすでに ${jn} に就いています！[/info]`);
                if (myM < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${mkRp(sId, rid, mId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                await supabase.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                return sendTempMessage(rid, `[info][title]🎉 転職完了[/title][piconname:${sId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(rid, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (0) ➡ [code]/work[/code] (100〜500) ※10%でミス0
🏛️ 公務員 (2,000) ➡ [code]/work[/code] (300〜500)
🚓 警察官 (3,000) ➡ [code]/work[/code] (300〜700) ＆ [code]/catch[/code]
⚽ プロスポーツ (5,000) ➡ [code]/work[/code] (500〜1000) ＆ [code]/goal[/code]
🎲 賭博師 (100,000) ➡ [code]/work[/code] (3000〜5000) ＆ [code]/slot-up[/code]
🔮 マスター (700,000) ➡ [code]/work[/code] (10000〜15000) ＆ [code]/cm[/code]
⏳ タイムトラベラー (1,000,000) ➡ [code]/work[/code] (15000〜20000) ＆ [code]/KK[/code], [code]/MK[/code]
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (pl.work_limit <= 0) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (pl.last_work_time || 0) < 600000) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                let e = 0, m = "";
                if(myJ === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJ === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJ === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${fNum(e)} コイン稼ぎました！⚽`; }
                else if(myJ === '賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`ギャンブルの合間に、 ${fNum(e)} コイン稼ぎました！🎲`; }
                else if(myJ === 'マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`究極の指導を行い、 ${fNum(e)} コイン稼ぎました！🔮`; }
                else if(myJ === 'タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`時空を超えて、 ${fNum(e)} コインを調達しました！⏳`; }
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: pl.work_limit - 1 }).eq('account_id', sId);
                await addMoneyWithRepay(sId, e); 
                return sendTempMessage(rid, `[info][title]💼 お仕事完了[/title][piconname:${sId}]\n${m}\n(残り ${pl.work_limit - 1} 回)[/info]`);
            }

            if (/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/.test(body) && gambleActive) {
                let cmd = body.match(/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/)[2];
                if (cmd === 'catch' && myJ !== '警察官') return; if (cmd === 'goal' && myJ !== 'プロスポーツ選手') return;
                if (cmd === 'slot-up' && myJ !== '賭博師') return; if (cmd === 'cm' && myJ !== 'マスター') return;
                if ((cmd === 'KK' || cmd === 'MK') && myJ !== 'タイムトラベラー') return;
                if (pl.skill_date === today) return sendTempMessage(rid, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                let msg = "";
                if (cmd === 'catch') { if (Math.random() < 0.3) { await addMoneyWithRepay(sId, 800); msg = `犯人を逮捕しました！特別報酬 800 コイン獲得！🚨`; } else msg = `犯人を逃してしまいました...🏃‍♂️💨`; } 
                else if (cmd === 'goal') { if (Math.random() < 0.3) { await addMoneyWithRepay(sId, 1000); msg = `スーパーゴールを決めました！特別報酬 1000 コイン獲得！🥅✨`; } else msg = `シュートは外れてしまいました...🤦‍♂️`; } 
                else if (cmd === 'slot-up') { let nl = Math.floor(Math.random() * 6) + 10; await supabase.from('players').update({ slot_limit: nl }).eq('account_id', sId); msg = `ギャンブル魂が燃え上がった！🔥 本日のスロット上限が ${nl} 回にアップしました！`; } 
                else if (cmd === 'cm') { if (Math.random() < 0.5) { cmState = { a: sId, e: Date.now() + 30 * 60000 }; msg = `マスターのオーラを展開！🔮\nここから30分間、他人がギャンブルで負けた額の50%を吸収します！`; } else msg = `オーラの展開に失敗しました...今日はもう使えません。💦`; } 
                else if (cmd === 'MK') { mkState = { a: sId }; msg = `未来予知完了...👁️✨\n次に行われるゲームで、あなたに80%の確率で「奇跡」が起こります！`; } 
                else if (cmd === 'KK') { let n = Date.now(), ts = betLogs.filter(l => n - l.t <= 300000), ds = {}; for (let l of ts) { if (!ds[l.a]) ds[l.a] = 0; ds[l.a] -= l.d; } for (let a in ds) { if (ds[a] !== 0) await addMoneyWithRepay(a, ds[a]); } betLogs = []; cmState = null; mkState = null; msg = `⏳ タイムトラベル発動！\n過去5分間にあった全てのギャンブル結果を「なかったこと」にしました！（全プレイヤーの損益が巻き戻りました）`; }
                await supabase.from('players').update({ skill_date: today }).eq('account_id', sId);
                return sendTempMessage(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}] 様\n\n${msg}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (pl.slot_count >= mSL) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のスロットは上限(${mSL}回)に達しました！[/info]`);
                if (Date.now() - Number(pl.last_slot_time || 0) < 120000) return sendTempMessage(roomId, `[info]⚠️ ${mkRp(sId, rid, mId)}\nスロット休憩中(2分間隔)です！[/info]`);
                let b = sM[2] === 'max' ? myM : (sM[2] === 'half' ? Math.floor(myM / 2) : parseInt(sM[2], 10));
                b = Math.min(b, 99999); // 上限
                if (b > 0 && myM >= b) {
                    await supabase.from('players').update({ money: myM - b, slot_count: pl.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', sId);
                    logBet(sId, -b); 
                    let r = Math.random() * 100, omi = (pl.omikuji_date === today) ? pl.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    if (mkState && mkState.a === sId && Math.random() < 0.8) { r = 0.05; mkState = null; oM = "(👁️MK発動!)"; }

                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=30; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (30倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = b * ml; if (wA > 0) { await addMoneyWithRepay(sId, wA); logBet(sId, wA); } else { await applyCM(b); }
                    return sendM(rid, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(b)} ➡ 獲得: ${fNum(wA)} コイン\n(残り回数: ${mSL - (pl.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myM < cost) return sendTempMessage(rid, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').maybeSingle();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ let s = ((rs+i) % (10000-cnt)) + 1; let ok = true; for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } if(ok){ st=s; break; } }
                        if(st === -1) return sendTempMessage(rid, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(rid, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN = av.slice(0, cnt);
                    }
                    await supabase.from('players').update({ money: myM - cost }).eq('account_id', sId); logBet(sId, -cost);
                    for (let n of mN) tks.push({ aid: sId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(rid, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時)[/info]`);
                }
            }

            // --- 🎲 テーブルゲーム (募集・参加・退出・進行) ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && gambleActive) {
                if (gSt[rid] && gSt[rid].s !== 'IDLE') return sendTempMessage(rid, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。[/info]`);
                let t = body.includes('/derby') ? 'db' : (body.includes('/cc') ? 'cc' : 'ch');
                gSt[rid] = { t: t, s: 'REC', h: sId, p: [{ a: sId, b: 0 }] };
                let tN = t==='db' ? "🐎 ダービー" : (t==='cc' ? "🎲 チンチロリン" : "🎲 丁半ゲーム"); 
                let ex = t==='db' ? "[code]/join derby[/code]" : (t==='cc' ? "[code]/join cc[/code]" : "[code]/join chouhan[/code]");
                if (t === 'db') { let dO = genDerby(); gSt[rid].oMp = dO.oddsMap; gSt[rid].oS = dO.oddsStr; gSt[rid].st = dO.stats; }
                return sendTempMessage(rid, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${sId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]ホストが [code]/start${t==='ch'?'chouhan':t}[/code] と打つと進行します。[/info]`); 
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && gambleActive && gSt[rid]?.s === 'REC') {
                if (!gSt[rid].p.find(x => x.a === sId)) { gSt[rid].p.push({ a: sId, b: 0 }); sendM(rid, `[info]🙋‍♂️ [piconname:${sId}] が参加しました！ (現在 ${gSt[rid].p.length}人)[/info]`); }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && gambleActive && gSt[rid]?.s === 'REC' && gSt[rid].h === sId) {
                if (gSt[rid].p.length < 2) return sendTempMessage(rid, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                gSt[rid].s = 'BET';
                if (gSt[rid].t === 'db') {
                    sendTempMessage(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n【 🐎 馬連オッズ 】\n${gSt[rid].oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)\n(制限2分。残り1分でリマインドします)[/info]`, 120000);
                    startTmr(rid, 120000, true);
                } else {
                    sendTempMessage(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n👉 [code]/bet [額][/code] でベットしてください。\n[hr](制限1分。/bet max 等も使えます)[/info]`, 60000);
                    startTmr(rid, 60000);
                }
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gSt[rid] && gSt[rid].s !== 'IDLE') {
                let idx = gSt[rid].p.findIndex(x => x.a === sId);
                if (idx !== -1) {
                    let cp = gSt[rid].p[idx]; gSt[rid].p.splice(idx, 1);
                    if (cp.b > 0) { await addMoneyWithRepay(sId, cp.b); logBet(sId, cp.b); }
                    sendTempMessage(rid, `[info]🚪 [piconname:${sId}] が退出しました。[/info]`);
                    if (gSt[rid].p.length === 0) { clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt); gSt[rid] = null; return sendTempMessage(rid, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); }
                    chkProg(rid);
                }
                return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gSt[rid]?.s === 'BET') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && pl.b === 0) {
                    let b = bM[2] === 'max' ? myM : (bM[2] === 'half' ? Math.floor(myM/2) : parseInt(bM[2], 10));
                    b = Math.min(b, 99999);
                    if (b > 0 && myM >= b) {
                        if (gSt[rid].t === 'db') {
                            let h = bM[3]; if (!h || !gSt[rid].oMp[h]) return sendTempMessage(rid, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください[/info]`);
                            pl.c = h;
                        }
                        pl.b = b; await supabase.from('players').update({ money: myM - b }).eq('account_id', sId); logBet(sId, -b);
                        sendTempMessage(rid, `[info]💰 [piconname:${sId}] ${fNum(b)} コインをベットしました！[/info]`);
                        chkProg(rid);
                    } else sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gSt[rid]?.t === 'ch' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.c) { pl.c = body.trim().slice(1); sendTempMessage(rid, `[info]🎯 [piconname:${sId}] 「${pl.c==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); chkProg(rid); }
            }

            if (body.trim() === '/roll' && gambleActive && gSt[rid]?.t === 'cc' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.res && sId !== gSt[rid].h) {
                    pl.res = getChinchiroRoll(); sendMsg(rid, `[info]🎲 [piconname:${sId}] の出目: ${pl.res.n}[/info]`); chkProg(rid);
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

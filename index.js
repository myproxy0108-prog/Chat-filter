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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; // 全ゲームの進行状況管理

supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

// --- Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySig = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- Chatwork Messages ---
const makeRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;
const sendM = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const sendT = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- お金・借金管理 (自動返済) ---
const addMoney = async (aid, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let m = p ? p.money : 0, d = p ? (p.debt || 0) : 0;
    if (d > 0 && amount > 0) { let r = Math.min(d, amount); d -= r; amount -= r; }
    m += amount;
    if (p) await supabase.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await supabase.from('players').insert({ account_id: aid, money: m, debt: d, slot_count: 0, work_limit: 5, msg_count: 0 });
};

// --- 管理・防衛 ---
const isAd = async (rid, aid) => {
    try { const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString()); return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTgt = async (rid, aids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`);
        let ad = c.filter(m=>m.role==='admin'||m.role==='creator').map(m=>m.account_id.toString());
        let me = c.filter(m=>m.role==='member').map(m=>m.account_id.toString());
        let ro = c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let found = false;
        for (let a of aids) {
            let id = a.toString();
            if (ad.includes(id) || me.includes(id) || ro.includes(id)) { found=true; ad=ad.filter(x=>x!==id); me=me.filter(x=>x!==id); ro=ro.filter(x=>x!==id); if(act==='readonly')ro.push(id); }
        }
        if (!found) return; 
        const p = new URLSearchParams();
        if (ad.length) p.append('members_admin_ids', ad.join(',')); if (me.length) p.append('members_member_ids', me.join(',')); if (ro.length) p.append('members_readonly_ids', ro.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e) {}
};

const chkSpam = (aid) => {
    const now = Date.now();
    if (!spamRecords[aid]) spamRecords[aid] = [];
    spamRecords[aid].push(now);
    spamRecords[aid] = spamRecords[aid].filter(t => now - t <= 5000);
    return (spamRecords[aid].length >= 10);
};

// --- ゲームエンジン ---
const genDb = () => {
    let st = []; for(let i=0; i<6; i++) st.push(Math.random()*10+1);
    let cb = [], tW = 0, mp = {}, s = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = st[i-1]*st[j-1]; cb.push({c:`${i}-${j}`, w}); tW += w; } }
    cb.forEach(c => { let o = (0.8/(c.w/tW)).toFixed(1); if(o<1.1)o=1.1; if(o>150)o=150.0; mp[c.c] = Number(o); });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : [code]${mp[k]}倍[/code]\n`; });
    return { mp, s, st };
};

const getDeck = () => {
    const su = ['♠','♥','♣','♦'], rk = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let dk = [];
    for (let s of su) for (let i = 0; i < rk.length; i++) dk.push({ s, r: rk[i], v: i + 2 });
    for (let i = dk.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [dk[i], dk[r]] = [dk[r], dk[i]]; }
    return dk;
};

const evalPk = (cards) => {
    let v = cards.map(c => c.v).sort((a,b)=>a-b), s = cards.map(c => c.s);
    let fl = s.every(x => x === s[0]), st = false;
    if (v[4]-v[0] === 4 && new Set(v).size === 5) st = true;
    if (v.join(',') === "2,3,4,5,14") { st = true; v = [1,2,3,4,5]; } // A-5
    let c = {}; v.forEach(x => c[x] = (c[x]||0)+1);
    let cA = Object.values(c).sort((a,b)=>b-a);
    
    if (fl && st) { if (v[4] === 14 && v[0] === 10) return { r: 10, n: "ロイヤルストレートフラッシュ", m: 100 }; return { r: 9, n: "ストレートフラッシュ", m: 50 }; }
    if (cA[0] === 4) return { r: 8, n: "フォーカード", m: 20 };
    if (cA[0] === 3 && cA[1] === 2) return { r: 7, n: "フルハウス", m: 10 };
    if (fl) return { r: 6, n: "フラッシュ", m: 5 };
    if (st) return { r: 5, n: "ストレート", m: 4 };
    if (cA[0] === 3) return { r: 4, n: "スリーカード", m: 3 };
    if (cA[0] === 2 && cA[1] === 2) return { r: 3, n: "ツーペア", m: 2 };
    if (cA[0] === 2) return { r: 2, n: "ワンペア", m: 1 }; // 等倍払い戻し(+1倍)
    return { r: 1, n: "ハイカード", m: 1 }; // 等倍払い戻し(+1倍)
};

const drawPk = (deck) => {
    let hand = []; for(let i=0; i<5; i++) hand.push(deck.pop());
    return { hand, ...evalPk(hand) };
};

// --- ゲーム進行・タイマー ---
const sTmr = (rid, ms = 60000, isDb = false) => {
    let g = gSt[rid]; if (!g) return;
    if (g.tid) clearTimeout(g.tid); if (g.rt) clearTimeout(g.rt);
    if (isDb) { g.rt = setTimeout(() => { if (gSt[rid]?.s === 'BET') sendT(rid, `[info]⏳ 競馬ベット締切1分前！\n[code]/bet [額] [馬1-馬2][/code] を入力してください。[/info]`); }, ms - 60000); }
    g.tid = setTimeout(() => hTO(rid), ms);
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'BET' && g.p.length >= 2 && g.p.every(p => p.b > 0)) {
        if (g.t === 'db') { clearTimeout(g.tid); if (g.rt) clearTimeout(g.rt); await resDb(rid); }
        else {
            g.s = 'ACT';
            let txt = g.t === 'ch' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言！" : "親以外は [code]/draw[/code] でカードを引いてください！";
            await sendT(rid, `[info][title]🎲 ゲーム進行[/title]全員ベット完了！\n${txt}\n[hr](制限1分)[/info]`);
            sTmr(rid, 60000);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.length >= 2 && g.p.every(p => p.c)) await resCh(rid);
        if (g.t === 'pk' && g.p.length >= 2 && g.p.filter(x => x.a !== g.h).every(p => p.res)) await resPk(rid);
    }
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'REC') {
        if (g.p.length >= 2) {
            g.s = 'BET';
            if (g.t === 'db') {
                let ex = `\n【 🐎 馬連オッズ 】\n${g.oS}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](制限2分。残り1分で通知します)[/info]`, 120000);
                sTmr(rid, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendT(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](制限1分。/bet max や half も可)[/info]`);
                sTmr(rid, 60000);
            }
        } else { await sendT(rid, `[info]⚠️ 参加者不足のためゲームを中止します。[/info]`); gSt[rid] = null; }
    } else {
        let kick = [], act = [];
        for (let p of g.p) {
            let k = false;
            if (g.s === 'BET' && p.b === 0) k = true;
            if (g.s === 'ACT' && (g.t === 'ch' && !p.c || g.t === 'pk' && !p.res && p.a !== g.h)) k = true;
            if (k) { kick.push(p.a); if (p.b > 0) await addMoney(p.a, p.b); } else act.push(p);
        }
        g.p = act;
        if (kick.length > 0) await sendT(rid, `[info]⏳ タイムアウトにより以下の方を退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        if (g.p.length < 2) {
            for (let p of g.p) if (p.b > 0) await addMoney(p.a, p.b);
            await sendT(rid, `[info]⚠️ 人数不足になったため中止し、全額返金しました。[/info]`); gSt[rid] = null;
        } else await chkProg(rid);
    }
};

// --- ゲーム精算 ---
const resPk = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pR = drawPk(g.dk); 
    let msg = `[info][title]🃏 ポーカー 結果発表[/title]【 親 ([piconname:${g.h}]) の手札 】\n[ ${pR.hand.map(c=>c.s+c.r).join(' ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        if (p.a === g.h) continue;
        let r = p.res || { r: -1, n: "欠席", m: 1, hand: [] };
        if (r.r === -1) { msg += `💀 [piconname:${p.a}]: 欠席 (没収)\n`; continue; }
        
        let win = (r.r > pR.r), draw = (r.r === pR.r);
        if (draw) { 
            await addMoney(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 引き分け (返金)\n`; 
        } else if (win) { 
            let m = r.m > 0 ? r.m : 1; await addMoney(p.a, p.b + (p.b * m)); 
            msg += `(cracker) [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 勝ち！ (+${fNum(p.b * m)})\n`; 
        } else { 
            msg += `💀 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 負け...\n`; 
        }
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; 
};

const resCh = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1, s = d1+d2, ans = (s%2===0)?'chou':'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${s}) ➡ 『 ${ans==='chou'?'丁(偶数)':'半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        if (p.c === ans) { await addMoney(p.a, p.b*2); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(p.b*2)} コイン)\n`; }
        else msg += `💀 [piconname:${p.a}]: 予想[${p.c==='chou'?'丁':'半'}] ➡ はずれ...\n`;
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; 
};

const resDb = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid); if (g.rt) clearTimeout(g.rt);
    let st = g.st, ws = [...st], tW = ws.reduce((a,b)=>a+b,0);
    let r1 = Math.random() * tW, s1 = 0, f = 1;
    for(let i=0; i<6; i++){ s1+=ws[i]; if(r1<=s1){ f=i+1; break; } }
    ws[f-1] = 0; tW = ws.reduce((a,b)=>a+b,0); let r2 = Math.random() * tW, s2 = 0, s = 1;
    for(let i=0; i<6; i++){ s2+=ws[i]; if(r2<=s2){ s=i+1; break; } }
    
    let wC = f < s ? `${f}-${s}` : `${s}-${f}`, od = g.oMp[wC];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬スタート！\n...\n\n先頭で駆け抜けたのは【 ${f} 】番と【 ${s} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${wC} 】 (${od}倍)\n[hr]【 プレイヤー結果 】\n`;
    for(let p of g.p){
        if(p.c === wC){ let w = Math.floor(p.b * od); await addMoney(p.a, p.b + w); msg += `(cracker) [piconname:${p.a}]: 的中！ (+${fNum(w)} コイン)\n`; }
        else msg += `💀 [piconname:${p.a}]: 予想[${p.c}] ➡ はずれ...\n`;
    }
    await sendM(rid, msg + "[/info]"); gSt[rid] = null; 
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySig(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event; if (!ev || ev.webhook_event_type !== 'message_created') return;
    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getTodayStr(), tMonth = getThisMonthStr();

    (async () => {
        try {
            // --- 返信タグ解析 ---
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // 1. BL防衛
            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            // 2. スパム防衛
            if (checkSpam(sId) && !(await isUserAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly'); return sendTemp(rid, `[info]⚠️ [piconname:${sId}] 連投につき閲覧制限しました。[/info]`);
            }

            // 3. 0時リセット & 宝くじ
            if (localLastResetDate !== today) {
                const { data: cD } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!cD || cD.value !== today) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    let m = `[info][title]🔄 日付更新[/title]深夜0時です。\nスロット回数、おみくじ、仕事制限がリセットされました！\n[hr]`;
                    
                    const { data: tD } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tD ? JSON.parse(tD.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ抽選[/title]当選番号は...【 ${win} 】です！\n[hr]`;
                        let pays = {}, wns = [];
                        const cP = (n, w) => {
                            if(n===w) return { p:30000, n:'🥇 1等' }; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return { p:15000, n:'🥈 前後賞' };
                            if(n%1000===w%1000) return { p:10000, n:'🥈 2等' }; if(n%100===w%100) return { p:5000, n:'🥉 3等' };    
                            if(n%10===w%10) return { p:1000, n:'🏅 4等' }; return null;
                        };
                        for (let t of tks) { let r = cP(t.num, win); if(r){ wns.push({a:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (wns.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            wns.sort((a,b)=>b.p-a.p); for (let w of wns.slice(0, 20)) m += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)})\n`;
                            if (wns.length>20) m += `...他 ${wns.length-20} 件の当選！\n`;
                        } else m += `本日の当選者はいませんでした。\n`;
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendM(rid, m + `[/info]`);
                }
            }

            // 4. データ取得 & 仕事サイレント回復
            let { data: pl } = await sb.from('players').select('*').eq('account_id', sId).single();
            if (!pl && gambleActive && !body.startsWith('/')) {
                await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン' });
                pl = { money: 0, debt: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン', slot_count: 0 };
            }
            if (gambleActive && pl && !body.startsWith('/')) {
                let mc = (pl.msg_count || 0) + 1; let wl = pl.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                await sb.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = pl?pl.money:0, myD = pl?(pl.debt||0):0, myJ = pl?(pl.job||'サラリーマン'):'サラリーマン';
            let cDb = (pl && pl.debt_month === tMonth) ? (pl.monthly_debt||0) : 0;

            // --- 📖 ヘルプ ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 総合案内 (V39 FINAL)[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 給料 (10分間隔, 1日5回上限)
・ [code]/catch[/code] または [code]/goal[/code] : 特殊能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [額|max|half][/code] : スロット (1日5回, 1分間隔)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム (間隔なし) 】
・ [code]/chouhan[/code] : 丁半
・ [code]/poker[/code] : ポーカー ([code]/draw[/code]でカードを引く)
・ [code]/derby[/code] : 競馬 ([code]/bet [額] [馬連][/code])

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : 進行中のゲームを強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効/無効化
・ [code]/blacklist[/code], [code]/remove-rank[/code][/info]`;
                return sendTemp(rid, h, 120000);
            }

            // --- 👑 管理者 ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                let a = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (tg && a > 0) { await addMoney(tg, a); return sendTemp(rid, `[info]👑 [piconname:${tg}] 様へ ${fNum(a)} コイン付与しました。[/info]`); }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                if (gSt[rid] && gSt[rid].s !== 'IDLE') {
                    for (let p of gSt[rid].p) if (p.b > 0) await addMoney(p.a, p.b);
                    clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt);
                    gSt[rid] = null; return sendTemp(rid, `[info]⚠️ 管理者によりゲームが強制終了・全額返金されました。[/info]`);
                } else return sendTemp(rid, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'rm' : 'ad');
                if(!tg && cmd !== 'ad') return; if(!tg && cmd === 'ad') cmd = 'ls';

                if (cmd === 'rank') {
                    const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i=>i!==tg); sendTemp(rid, `[info][piconname:${tg}] ランキング除外解除[/info]`); }
                    else { ex.push(tg); sendTemp(rid, `[info][piconname:${tg}] ランキング除外[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'ad') { await sb.from('blacklist').insert({account_id:tg}); await kickTarget(rid,[tg],'readonly'); return sendTemp(rid, `[info]🚫 [piconname:${tg}] をBL登録しました。[/info]`); }
                else if (cmd === 'rm') { await sb.from('blacklist').delete().eq('account_id',tg); return sendTemp(rid, `[info]✅ [piconname:${tg}] のBLを解除しました。[/info]`); }
                else if (cmd === 'ls') { 
                    const { data: ls } = await sb.from('blacklist').select('account_id'); 
                    return sendTemp(rid, `[info][title]📜 BL一覧[/title]${ls&&ls.length?ls.map(d=>`[piconname:${d.account_id}]`).join('\n'):"なし"}[/info]`); 
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(rid, sId)) { gambleActive=true; await sb.from('config').upsert({key:'gamble_active', value:'true'}); return sendM(rid, `[info]🎰 システム【 有効 】[/info]`); }
            if (body.startsWith('/fi-gya') && await isUserAdmin(rid, sId)) { gambleActive=false; await sb.from('config').upsert({key:'gamble_active', value:'false'}); return sendM(rid, `[info]🚫 システム【 停止 】[/info]`); }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (pl && pl.omikuji_date === today) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のおみくじは既に引いています。(結果: ${pl.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通り。"; } else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通り。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                if (pl) await sb.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, omikuji_date: today, omikuji_result: res });
                return sendM(rid, `[info][title]⛩️ おみくじ結果[/title]${mkRp(sId, rid, mId)}\n[hr]今日の運勢...【 ${res} 】！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && gambleActive) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (cDb + a > 5000) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n1ヶ月の借金上限(5000)を超過します！(今月既に ${cDb} 借りています)[/info]`);
                    if (pl) await sb.from('players').update({money: myM + a, debt: myD + a, monthly_debt: cDb + a, debt_month: tMonth}).eq('account_id', sId);
                    else await sb.from('players').insert({account_id: sId, money: a, debt: a, monthly_debt: a, debt_month: tMonth});
                    return sendTemp(rid, `[info]💳 [piconname:${sId}] 様\n${fNum(a)} コイン借金しました。\n(今月の枠: 残り ${fNum(5000 - (cDb + a))} )[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, myM - myD); if (av < a) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n送金枠(純資産)が不足しています！(送金可能額: ${fNum(av)})[/info]`);
                    let tx = Math.floor(a * 0.10); let rAmt = a - tx;
                    await sb.from('players').update({ money: myM - a }).eq('account_id', sId);
                    const { data: rc } = await sb.from('players').select('*').eq('account_id', tg).single();
                    if (rc) await sb.from('players').update({ money: rc.money + rAmt }).eq('account_id', tg);
                    else await sb.from('players').insert({ account_id: tg, money: rAmt, debt: 0 });
                    return sendTemp(rid, `[info]🎁 [piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(a)} コイン送金しました。\n(※システム税10%が引かれ、相手には ${fNum(rAmt)} 届きました)[/info]`);
                }
            }

            if (body.trim() === '/status') {
                if (pl) {
                    const rS = Math.max(0, 5 - pl.slot_count);
                    return sendTemp(rid, `[info][title]📊 ステータス[/title][piconname:${sId}]\n💰 所持金: ${fNum(myM)} ${myD>0?`\n💳 借金: -${fNum(myD)}`:''}\n💎 純資産: ${fNum(myM - myD)}\n[hr]👔 職業: ${myJ}\n🎰 スロット残: ${rS} 回\n💼 お仕事残: ${pl.work_limit} 回\n⛩️ 今日の運勢: ${pl.omikuji_result || '未引'}[/info]`);
                } else return sendTemp(rid, `[info]データがありません。[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single(); 
                let ex = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await sb.from('players').select('*'); 
                let f = ls ? ls.filter(d => !ex.includes(d.account_id)) : [];
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(net)} ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTemp(rid, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に消滅します[/info]`, 300000);
            }

            // --- 💼 職業 ---
            const cJM = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJM && gambleActive) {
                const jn = cJM[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJ === jn) return sendTemp(rid, `[info]⚠️ すでに ${jn} です！[/info]`);
                if (myM < cs[jn]) return sendTemp(rid, `[info]⚠️ お金が足りません！(費用: ${fNum(cs[jn])})[/info]`);
                if (pl) await sb.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, job: jn, money: -cs[jn] });
                return sendTemp(rid, `[info]🎉 [piconname:${sId}] 様\n${jn} に転職しました！ (-${fNum(cs[jn])})[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTemp(rid, `[info][title]💼 求人[/title]👨‍💼 サラリーマン(0)\n🏛️ 公務員(2000)\n🚓 警察官(3000)\n⚽ プロ(5000)\n※転職: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive && pl) {
                if (pl.work_limit <= 0) return sendTemp(rid, `[info]⚠️ 今日の仕事回数が上限(5回)です。[/info]`);
                if (Date.now() - (pl.last_work_time || 0) < 600000) return sendTemp(rid, `[info]⚠️ 休憩中です！(10分間隔)[/info]`);
                let e = 0, m = "";
                if(myJ === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="大きなミスをして、給料 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJ === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJ === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJ === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${fNum(e)} コイン稼ぎました！⚽`; }
                await sb.from('players').update({ last_work_time: Date.now(), work_limit: pl.work_limit - 1 }).eq('account_id', sId);
                await addMoney(sId, e); return sendTemp(rid, `[info]💼 [piconname:${sId}]\n${m}\n(残り ${pl.work_limit - 1} 回)[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive && pl) {
                let iC = /(^|\n)\/catch\b/.test(body);
                if (iC && myJ !== '警察官') return sendTemp(rid, `[info]⚠️ 警察官専用です！[/info]`);
                if (!iC && myJ !== 'プロスポーツ選手') return sendTemp(rid, `[info]⚠️ プロ専用です！[/info]`);
                if (pl.skill_date === today) return sendTemp(rid, `[info]⚠️ 今日の特殊能力は使用済みです！[/info]`);
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){ e=800; m=`犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; } else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){ e=1000; m=`スーパーゴール！スポンサーから ${e} コイン獲得！🥅✨`; } else m=`シュートは外れてしまいました...🤦‍♂️`; }
                await sb.from('players').update({ skill_date: today }).eq('account_id', sId);
                await addMoney(sId, e); return sendTemp(rid, `[info]✨ [piconname:${sId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive && pl) {
                if (pl.slot_count >= 5) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のスロットは上限(1日5回)です！[/info]`);
                if (Date.now() - Number(pl.last_slot_time || 0) < 60000) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nスロット休憩中(1分間隔)です！[/info]`);
                
                let b = sM[2] === 'max' ? myM : (sM[2] === 'half' ? Math.floor(myM / 2) : parseInt(sM[2], 10));
                if (b > 0 && myM >= b) {
                    await sb.from('players').update({ money: myM - b, slot_count: pl.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', sId);
                    
                    // 0.1%基準、大吉で0.5%
                    let r = Math.random() * 100;
                    let omi = (pl.omikuji_date === today) ? pl.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = b * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendM(rid, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(b)} ➡ 獲得: ${fNum(wA)} コイン\n(残り: ${5 - (pl.slot_count + 1)}回)[/info]`);
                } else return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTemp(rid, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)})[/info]`);
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ let s = ((rs+i) % (10000-cnt)) + 1; let ok = true; for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } if(ok){ st=s; break; } }
                        if(st === -1) return sendTemp(rid, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTemp(rid, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN = av.slice(0, cnt);
                    }
                    await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', sId);
                    for (let n of mN) tks.push({ aid: sId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTemp(rid, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入！\n番号: ${ns}[/info]`);
                }
            }

            // --- 🎲 ポーカー (新規実装) ---
            const evalPk = (cards) => {
                let v = cards.map(c => c.v).sort((a,b)=>a-b), s = cards.map(c => c.s);
                let fl = s.every(x => x === s[0]), st = false;
                if (v[4]-v[0] === 4 && new Set(v).size === 5) st = true;
                if (v.join(',') === "2,3,4,5,14") { st = true; v = [1,2,3,4,5]; }
                let c = {}; v.forEach(x => c[x] = (c[x]||0)+1);
                let cA = Object.values(c).sort((a,b)=>b-a);
                
                if (fl && st) { if (v[4] === 14 && v[0] === 10) return { r: 10, n: "ロイヤルストレートフラッシュ", m: 100 }; return { r: 9, n: "ストレートフラッシュ", m: 50 }; }
                if (cA[0] === 4) return { r: 8, n: "フォーカード", m: 20 };
                if (cA[0] === 3 && cA[1] === 2) return { r: 7, n: "フルハウス", m: 10 };
                if (fl) return { r: 6, n: "フラッシュ", m: 5 };
                if (st) return { r: 5, n: "ストレート", m: 4 };
                if (cA[0] === 3) return { r: 4, n: "スリーカード", m: 3 };
                if (cA[0] === 2 && cA[1] === 2) return { r: 3, n: "ツーペア", m: 2 };
                if (cA[0] === 2) return { r: 2, n: "ワンペア", m: 1 }; 
                return { r: 1, n: "ハイカード", m: 1 };
            };

            const getDeck = () => {
                const su = ['♠','♥','♣','♦'], rk = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
                let dk = []; for (let s of su) for (let i = 0; i < rk.length; i++) dk.push({ s, r: rk[i], v: i + 2 });
                for (let i = dk.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [dk[i], dk[r]] = [dk[r], dk[i]]; }
                return dk;
            };

            const resPk = async (rid) => {
                let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
                let botHand = []; for(let i=0;i<5;i++) botHand.push(g.dk.pop());
                let pR = { hand: botHand, ...evalPk(botHand) };
                
                let msg = `[info][title]🃏 ポーカー 結果発表[/title]【 親 ([piconname:${g.h}]) の手札 】\n[ ${pR.hand.map(c=>c.s+c.r).join(' ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
                for (let p of g.p) {
                    if (p.a === g.h) continue;
                    let r = p.res || { r: -1, n: "欠席", m: 1, hand: [] };
                    if (r.r === -1) { msg += `💀 [piconname:${p.a}]: 欠席 (没収)\n`; continue; }
                    let win = r.r > pR.r, draw = r.r === pR.r;
                    if (draw) { await addMoney(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 引き分け (返金)\n`; }
                    else if (win) { let m = r.m > 0 ? r.m : 1; await addMoney(p.a, p.b + (p.b * m)); msg += `(cracker) [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 勝ち！ (+${fNum(p.b * m)})\n`; }
                    else { msg += `💀 [piconname:${p.a}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 負け...\n`; }
                }
                sendM(rid, msg + "[/info]"); gSt[rid] = null;
            };

            // --- 🎲 ゲーム共通 (募集・参加・退出) ---
            if (body.match(/(^|\n)\/(chouhan|poker|derby)\b/) && gambleActive) {
                if (gSt[rid]) return sendTemp(rid, `[info]⚠️ 現在、別のゲームが進行中です。[/info]`);
                
                let t = body.includes('/derby') ? 'db' : (body.includes('/poker') ? 'pk' : 'ch');
                gSt[rid] = { t: t, s: 'REC', h: sId, p: [{ a: sId, b: 0 }] };
                
                let tN = t==='db' ? "🐎 ダービー" : (t==='pk' ? "🃏 ポーカー" : "🎲 丁半ゲーム"); 
                let ex = t==='db' ? "[code]/join derby[/code]" : (t==='pk' ? "[code]/join pk[/code]" : "[code]/join chouhan[/code]");
                
                if (t === 'db') { let dO = genDerby(); gSt[rid].oMp = dO.mp; gSt[rid].oS = dO.s; gSt[rid].st = dO.st; }
                if (t === 'pk') { gSt[rid].dk = getDeck(); }
                
                sendTemp(rid, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${sId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※1分経過で自動進行します。[/info]`); 
                sTmr(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|pk|derby)/) && gambleActive && gSt[rid]?.s === 'REC') {
                if (!gSt[rid].p.find(x => x.a === sId)) { 
                    gSt[rid].p.push({ a: sId, b: 0 }); 
                    sendM(rid, `[info]🙋‍♂️ [piconname:${sId}] が参加！ (現在 ${gSt[rid].p.length}人)[/info]`); 
                } return;
            }

            if (body.match(/(^|\n)\/start(chouhan|pk|derby)/) && gambleActive && gSt[rid]?.s === 'REC' && gSt[rid].h === sId) {
                if (gSt[rid].p.length < 2) return sendTemp(rid, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gSt[rid].tid); hTO(rid); return;
            }

            if (body.trim() === '/leave' && gambleActive && gSt[rid]) {
                let idx = gSt[rid].p.findIndex(p => p.a === sId);
                if (idx !== -1) {
                    let p = gSt[rid].p[idx]; gSt[rid].p.splice(idx, 1);
                    if (p.b > 0) await addMoney(sId, p.b); 
                    sendTemp(rid, `[info]🚪 [piconname:${sId}] が退出しました。[/info]`);
                    if (gSt[rid].p.length === 0) { clearTimeout(gSt[rid].tid); if (gSt[rid].rt) clearTimeout(gSt[rid].rt); gSt[rid] = null; return sendTemp(rid, `[info]⚠️ 参加者が0人になり中止。[/info]`); }
                    chkProg(rid);
                } return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gSt[rid]?.s === 'BET') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && pl.b === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10));
                    if (b > 0 && myMoney >= b) {
                        if (gSt[rid].t === 'db') {
                            let h = bM[3]; if (!h || !gSt[rid].oMp[h]) return sendTemp(rid, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください[/info]`);
                            pl.c = h;
                        }
                        pl.b = b; await sb.from('players').update({ money: myMoney - b }).eq('account_id', sId);
                        sendTemp(rid, `[info]💰 [piconname:${sId}] ${fNum(b)} コインをベットしました！[/info]`);
                        chkProg(rid);
                    } else sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
                } return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gSt[rid]?.t === 'ch' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.c) { pl.c = body.trim().slice(1); sendTemp(rid, `[info]🎯 [piconname:${sId}] 「${pl.c==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); chkProg(rid); }
            }

            if (body.trim() === '/draw' && gambleActive && gSt[rid]?.t === 'pk' && gSt[rid].s === 'ACT') {
                let pl = gSt[rid].p.find(x => x.a === sId);
                if (pl && !pl.res && sId !== gSt[rid].h) {
                    let hand = []; for(let i=0;i<5;i++) hand.push(gSt[rid].dk.pop());
                    pl.res = { hand, ...evalPk(hand) };
                    sendMsg(rid, `[info]🃏 [piconname:${sId}] の役: ${pl.res.n} [ ${pl.res.hand.map(c=>c.s+c.r).join(' ')} ][/info]`); 
                    chkProg(rid);
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

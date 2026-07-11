const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- グローバル変数 ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; // 全ゲームの進行状況管理

supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- チャット操作関数 ---
const makeRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;
const sendMessage = async (rid, txt) => { try { await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`); } catch(e){} };
const deleteMessage = async (rid, mid) => { try { await cw.delete(`/rooms/${rid}/messages/${mid}`); } catch(e){} };
const sendTempMessage = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- お金管理 ---
const addMoneyWithRepay = async (aid, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let money = p ? p.money : 0, debt = p ? (p.debt || 0) : 0;
    if (debt > 0 && amount > 0) { let repay = Math.min(debt, amount); debt -= repay; amount -= repay; }
    money += amount;
    if (p) await supabase.from('players').update({ money, debt }).eq('account_id', aid);
    else await supabase.from('players').insert({ account_id: aid, money, debt, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 0 });
};

// マスターの税金徴収
const applyMasterTax = async (lostAmount) => {
    try {
        const { data: mData } = await supabase.from('config').select('value').eq('key', 'master_buff').single();
        if (mData) {
            let buff = JSON.parse(mData.value);
            if (buff && buff.aid && buff.expire > Date.now()) {
                let tax = Math.floor(lostAmount * 0.5);
                if (tax > 0) {
                    const { data: mp } = await supabase.from('players').select('money').eq('account_id', buff.aid).single();
                    if (mp) await supabase.from('players').update({ money: mp.money + tax }).eq('account_id', buff.aid);
                }
            }
        }
    } catch(e) {}
};

// 未来改変の消費と判定
const consumeMiraiBuff = async (aid) => {
    try {
        const { data: mData } = await supabase.from('config').select('value').eq('key', 'mirai_buff').single();
        if (mData && mData.value === aid.toString()) {
            await supabase.from('config').upsert({ key: 'mirai_buff', value: '' });
            return Math.random() < 0.8; // 80%の確率で発動
        }
        return false;
    } catch(e) { return false; }
};

// 履歴保存 (過去改変用: 直近5分の全員の残高)
const recordMoneyHistory = async () => {
    try {
        const { data: pList } = await supabase.from('players').select('account_id, money');
        const { data: hData } = await supabase.from('config').select('value').eq('key', 'money_history').single();
        let history = hData ? JSON.parse(hData.value) : [];
        const now = Date.now();
        history = history.filter(h => now - h.time <= 300000); // 5分以内のデータのみ保持
        history.push({ time: now, players: pList });
        await supabase.from('config').upsert({ key: 'money_history', value: JSON.stringify(history) });
    } catch(e) {}
};

// --- 防衛機能 ---
const isUserAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const updateRoomMembers = async (rid, targetAids, action = 'readonly') => {
    try {
        const { data: membersList } = await cw.get(`/rooms/${rid}/members`);
        let admins = membersList.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = membersList.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = membersList.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let found = false;

        for (const aid of targetAids) {
            let id = aid.toString();
            if (admins.includes(id) || members.includes(id) || readonlys.includes(id)) found = true;
            admins = admins.filter(x => x !== id); members = members.filter(x => x !== id); readonlys = readonlys.filter(x => x !== id);
            if (action === 'readonly') readonlys.push(id);
        }
        if (!found) return;
        const p = new URLSearchParams();
        if (admins.length > 0) p.append('members_admin_ids', admins.join(','));
        if (members.length > 0) p.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) p.append('members_readonly_ids', readonlys.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e) {}
};

// --- ゲームエンジン ---
const generateDerby = () => {
    let stats = []; for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0, oddsMap = {}, oddsStr = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = stats[i-1] * stats[j-1]; combos.push({ c: `${i}-${j}`, w }); totalWeight += w; } }
    combos.forEach(c => { let o = (0.8 / (c.w / totalWeight)).toFixed(1); if (o < 1.1) o = 1.1; if (o > 150) o = 150.0; oddsMap[c.c] = Number(o); });
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => { oddsStr += `🐎 ${k} : [code]${oddsMap[k]}倍[/code]\n`; });
    return { oddsMap, oddsStr, stats };
};

const getChinchiroRoll = () => {
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

const generateDeck = () => {
    const suits = ['♠', '♥', '♣', '♦'], ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let s of suits) for (let r of ranks) deck.push({ suit: s, rank: r, val: (r === 'A') ? 1 : (['J', 'Q', 'K'].includes(r) ? 10 : parseInt(r)) });
    for(let i = deck.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [deck[i], deck[r]] = [deck[r], deck[i]]; }
    return deck;
};

const calcBJScore = (hand) => {
    let sc = 0, a = 0;
    for (let c of hand) { if (c.rank === 'A') { a++; sc += 11; } else sc += c.val; }
    while (sc > 21 && a > 0) { sc -= 10; a--; }
    return sc;
};

// --- ゲーム進行チェック (時間制限なし) ---
const checkGameProgress = async (rid) => {
    let g = gameState[rid]; if (!g || g.state === 'IDLE') return;
    
    if (g.state === 'BETTING' && g.players.length >= (g.type === 'bj' ? 1 : 2) && g.players.every(p => p.bet > 0)) {
        if (g.type === 'derby') {
            await resolveDerby(rid);
        } else if (g.type === 'bj') {
            g.state = 'ACTION';
            g.deck = generateDeck(); g.dealerHand = [g.deck.pop(), g.deck.pop()];
            let msg = `[info][title]🃏 ブラックジャック 開始[/title]全員ベット完了！\n\n【 ディーラー 】\n🎴 ${g.dealerHand[0].suit}${g.dealerHand[0].rank} / [裏]\n[hr]【 プレイヤー 】\n`;
            for (let p of g.players) {
                p.hand = [g.deck.pop(), g.deck.pop()];
                let pSc = calcBJScore(p.hand);
                msg += `[piconname:${p.aid}]: ${p.hand.map(c=>c.suit+c.rank).join(' ')} (スコア: ${pSc})`;
                if (pSc === 21) { p.status = 'bj'; msg += ` 🎉 BJ！\n`; } else { p.status = 'playing'; msg += `\n`; }
            }
            msg += `[/info]`;
            await sendMessage(rid, msg);
            g.turnIndex = 0;
            await proceedNextBJTurn(rid);
        } else {
            g.state = 'ACTION';
            let txt = g.type === 'chouhan' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "親以外は [code]/roll[/code] でサイコロを振ってください。";
            await sendMessage(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}[/info]`);
        }
    } else if (g.state === 'ACTION') {
        if (g.type === 'chouhan' && g.players.length >= 2 && g.players.every(p => p.choice)) await resolveChouhan(rid);
        if (g.type === 'cc' && g.players.length >= 2 && g.players.filter(x => x.aid !== g.host).every(p => p.res)) await resolveChinchiro(rid);
    }
};

const proceedNextBJTurn = async (rid) => {
    let g = gameState[rid]; if (!g || g.type !== 'bj') return;
    while (g.turnIndex < g.players.length) {
        let p = g.players[g.turnIndex];
        if (p.status !== 'playing') { g.turnIndex++; continue; }
        let sc = calcBJScore(p.hand);
        await sendMessage(rid, `[info][title]🃏 ターン進行[/title][piconname:${p.aid}] さんの番です！\n手札: ${p.hand.map(c=>c.suit+c.rank).join(' ')} (スコア: ${sc})\n\n👉 [code]/hit[/code] または [code]/stand[/code] を入力してください。[/info]`);
        return;
    }
    await resolveBJ(rid);
};

// --- 結果精算 ---
const resolveBJ = async (rid) => {
    let g = gameState[rid]; if (!g) return;
    let dH = g.dealerHand, dSc = calcBJScore(dH);
    let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラー 】\n伏せカードは ${dH[1].suit}${dH[1].rank} でした。\n`;
    while(dSc < 17) { let c = g.deck.pop(); dH.push(c); dSc = calcBJScore(dH); msg += `➡ 引いた: ${c.suit}${c.rank}\n`; }
    msg += `最終手札: ${dH.map(c=>c.suit+c.rank).join(' ')} (スコア: ${dSc})\n`; if (dSc > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    
    for (let p of g.players) {
        let pSc = calcBJScore(p.hand), wA = 0, rT = "";
        let isMirai = await consumeMiraiBuff(p.aid); // 未来改変チェック
        if (isMirai) { p.status = 'bj'; pSc = 21; dSc = 22; msg += `🌟 未来改変発動！\n`; }

        if (p.status === 'bust') { rT = `💀 負け`; await applyMasterTax(p.bet); } 
        else if (p.status === 'bj') {
            if (dSc === 21 && dH.length === 2) { rT = `😐 引き分け`; await addMoneyWithRepay(p.aid, p.bet); } 
            else { wA = Math.floor(p.bet * 2.5); rT = `(cracker) 勝利(BJ)！ (+${fNum(wA)})`; await addMoneyWithRepay(p.aid, p.bet + wA); }
        } else {
            if (dSc > 21 || pSc > dSc) { wA = p.bet * 2; rT = `🎉 勝利！ (+${fNum(wA)})`; await addMoneyWithRepay(p.aid, p.bet + wA); } 
            else if (pSc === dSc) { rT = `😐 引き分け`; await addMoneyWithRepay(p.aid, p.bet); } 
            else { rT = `💀 負け`; await applyMasterTax(p.bet); }
        }
        msg += `[piconname:${p.aid}]: スコア ${pSc} ➡ ${rT}\n`;
    }
    await sendMessage(rid, msg + "[/info]"); gameState[rid] = null;
};

const resolveChinchiro = async (rid) => {
    let g = gameState[rid]; if (!g) return;
    let pR = getChinchiroRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${g.host}]) の出目 】\n[ ${pR.d.join(', ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of g.players) {
        if (p.aid === g.host) continue;
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let isMirai = await consumeMiraiBuff(p.aid);
        let win = isMirai || (r.r > pR.r) || (r.r === pR.r && r.s > pR.s);
        let draw = !isMirai && (r.r === pR.r && r.s === pR.s);
        
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if (draw) { await addMoneyWithRepay(p.aid, p.bet); msg += `😐 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 引き分け\n`; }
        else if (win) { let ml = r.m > 0 ? r.m : 1; await addMoneyWithRepay(p.aid, p.bet + (p.bet * ml)); msg += `(cracker) [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.bet * ml)})\n`; }
        else { msg += `💀 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 負け\n`; await applyMasterTax(p.bet); }
    }
    await sendMessage(rid, msg + "[/info]"); gameState[rid] = null;
};

const resolveChouhan = async (rid) => {
    let g = gameState[rid]; if (!g) return;
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, sum = d1 + d2, res = (sum % 2 === 0) ? 'chou' : 'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${res === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of g.players) {
        let isMirai = await consumeMiraiBuff(p.aid);
        let isWin = isMirai || (p.choice === res);
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if (isWin) { await addMoneyWithRepay(p.aid, p.bet * 2); msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(p.bet * 2)})\n`; } 
        else { msg += `💀 [piconname:${p.aid}]: はずれ...\n`; await applyMasterTax(p.bet); }
    }
    await sendMessage(rid, msg + "[/info]"); gameState[rid] = null;
};

const resolveDerby = async (rid) => {
    let g = gameState[rid]; if (!g) return;
    let st = g.st, ws = [...st], tW = ws.reduce((a, b) => a + b, 0);
    let r1 = Math.random() * tW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    ws[first-1] = 0; tW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * tW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`, odd = g.oddsMap[winCombo];
    
    let msg = `[info][title]🐎 ダービー 結果発表[/title]1着: ${first}番 / 2着: ${second}番\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    for(let p of g.players){
        let isMirai = await consumeMiraiBuff(p.aid);
        let isWin = isMirai || (p.choice === winCombo);
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if(isWin){ let wA = Math.floor(p.bet * odd); await addMoneyWithRepay(p.aid, p.bet + wA); msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(wA)})\n`; } 
        else { msg += `💀 [piconname:${p.aid}]: はずれ...\n`; await applyMasterTax(p.bet); }
    }
    await sendMessage(rid, msg + "[/info]"); gameState[rid] = null;
};

// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getTodayStr(), tMonth = getThisMonthStr();

    (async () => {
        try {
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpMatch ? rpMatch[1] : null;

            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', sId).single();
            if (isBanned) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            if (!spamRecords[sId]) spamRecords[sId] = [];
            spamRecords[sId].push(Date.now());
            spamRecords[sId] = spamRecords[sId].filter(t => Date.now() - t <= 5000);
            if (spamRecords[sId].length >= 10 && !(await isUserAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTempMessage(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投行為を検知したため、「閲覧のみ」に制限しました。[/info]`);
            }

            if (localLastResetDate !== today) {
                const { data: cD } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!cD || cD.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, extra_slots: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    
                    let resetMsg = `[info][title]🔄 日付更新[/title]深夜0時を回りました。\n各種制限がリセットされました！\n[hr]`;
                    const { data: tD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tD ? JSON.parse(tD.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号:【 ${win} 】\n[hr]`;
                        let pays = {}, winners = [];
                        const chP = (n, w) => {
                            if (n === w) return { p: 30000, name: '🥇 1等' };
                            let prev = w - 1 < 1 ? 9999 : w - 1, next = w + 1 > 9999 ? 1 : w + 1;
                            if (n === prev || n === next) return { p: 15000, name: '🥈 前後賞' };
                            if (n % 1000 === w % 1000) return { p: 10000, name: '🥈 2等' }; 
                            if (n % 100 === w % 100) return { p: 5000, name: '🥉 3等' };    
                            if (n % 10 === w % 10) return { p: 1000, name: '🏅 4等' };      
                            return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r) { winners.push({ a: t.aid, num: t.num, ...r }); pays[t.aid] = (pays[t.aid] || 0) + r.p; } }
                        if (winners.length > 0) {
                            for (let a in pays) await addMoneyWithRepay(a, pays[a]);
                            winners.sort((a,b) => b.p - a.p); 
                            for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${fNum(w.p)})\n`;
                            if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                        } else resetMsg += `本日の当選者はいませんでした。\n`;
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMessage(rid, resetMsg + `[/info]`);
                }
            }

            // 履歴の記録 (1分に1回程度)
            if (Math.random() < 0.1) recordMoneyHistory();

            let { data: player } = await supabase.from('players').select('*').eq('account_id', sId).single();
            if (!player && gambleActive && !body.startsWith('/')) {
                player = { account_id: sId, money: 0, debt: 0, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 1, job: 'サラリーマン' };
                await supabase.from('players').insert(player);
            } else if (gambleActive && player && !body.startsWith('/')) {
                let mc = (player.msg_count || 0) + 1, wl = player.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = player ? player.money : 0, myD = player ? (player.debt || 0) : 0, myJ = player ? (player.job || 'サラリーマン') : 'サラリーマン';
            let cDb = (player && player.debt_month === tMonth) ? (player.monthly_debt || 0) : 0;

            if (body.trim() === '/help-gya') {
                return sendTempMessage(rid, `[info][title]🎰 カジノ＆ライフ 総合案内 (V38 FINAL)[/title]
【🏦 銀行】 /status, /give [金], /debt [金], /money-rank
【💼 職業】 /job, /work, /catch, /goal, /changemaster, /boostslot, /過去改変, /未来改変
【🎰 カジノ】 /slot [金|max|half], /buy-lot [連番|バラ] [枚], /omikuji
【🎲 ゲーム】 /chouhan, /cc, /derby, /bet [金]
【👑 管理】 /take [金], /st-gya, /fi-game, /blacklist[/info]`, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (tg && amt > 0) { await addMoneyWithRepay(tg, amt); return sendTempMessage(rid, `[info][title]👑 資金付与[/title]管理者が [piconname:${tg}] 様へ ${fNum(amt)} コインを付与しました。[/info]`); }
            }
            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(rid, sId)) {
                if (gameState[rid] && gameState[rid].state !== 'IDLE') {
                    for (let p of gameState[roomId].players) { if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet); }
                    clearTimeout(gameState[rid].timeoutId); if (gameState[rid].remindId) clearTimeout(gameState[rid].remindId);
                    gameState[rid] = null; return sendTempMessage(rid, `[info][title]⚠️ 強制終了[/title]管理者がゲームを強制終了し全額返還しました。[/info]`);
                }
            }
            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!tg && cmd !== 'add') return; if (!tg && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i => i !== tg); sendTempMessage(rid, `[info][piconname:${tg}] ランキング除外を解除しました。[/info]`); }
                    else { ex.push(tg); sendTempMessage(rid, `[info][piconname:${tg}] ランキングから除外しました。[/info]`); }
                    return await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await supabase.from('blacklist').insert({account_id: tg}); await kickTarget(rid, [tg], 'readonly'); return sendTempMessage(rid, `[info]🚫 [piconname:${tg}] をBL登録しました。[/info]`); }
                else if (cmd === 'remove') { await supabase.from('blacklist').delete().eq('account_id', tg); return sendTempMessage(rid, `[info]✅ [piconname:${tg}] のBLを解除しました。[/info]`); }
                else if (cmd === 'list') { const { data: ls } = await supabase.from('blacklist').select('account_id'); const listStr = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし"; return sendTempMessage(rid, `[info][title]📜 BL一覧[/title]${listStr}[/info]`); }
            }
            if (body.startsWith('/st-gya') && await isUserAdmin(rid, sId)) { gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); return sendMessage(rid, `[info]🎰 カジノ＆ライフ 有効化[/info]`); }
            if (body.startsWith('/fi-gya') && await isUserAdmin(rid, sId)) { gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); return sendMessage(rid, `[info]🚫 カジノ＆ライフ 無効化[/info]`); }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (player && player.omikuji_date === today) return sendTempMessage(rid, `[info]⚠️ ${makeRp(sId, rid, mId)}\n本日のおみくじは既に引いています。(${player.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通り。"; } else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通り。"; } else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                return sendMessage(rid, `[info][title]⛩️ おみくじ[/title]${makeRp(sId, rid, mId)}\n今日の運勢: 【 ${res} 】\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && gambleActive) {
                let amt = parseInt(dbM[2], 10);
                if (amt > 0) {
                    if (amt > 99999) return sendTempMessage(rid, "⚠️ 賭け・借金の上限は 99999 コインです！");
                    if (cDb + amt > 5000) return sendTempMessage(rid, `[info]⚠️ 月の借金上限(5000)を超過します！(今月既に ${cDb})[/info]`);
                    if (player) await supabase.from('players').update({ money: myM + amt, debt: myD + amt, monthly_debt: cDb + amt, debt_month: thisMonth }).eq('account_id', sId);
                    else await supabase.from('players').insert({ account_id: sId, money: amt, debt: amt, monthly_debt: amt, debt_month: thisMonth });
                    return sendTempMessage(rid, `[info]💳 [piconname:${sId}]\n${fNum(amt)} コインを借金しました。(枠残り ${fNum(5000 - (cDb + amt))})[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && amt > 0) {
                    let av = Math.max(0, myM - myD); 
                    if (av < amt) return sendTempMessage(rid, `[info]⚠️ ${makeRp(sId, rid, mId)}\n送金枠(純資産)が不足！(可能額: ${fNum(av)})[/info]`);
                    let tax = Math.floor(amt * 0.10); let rAmt = amt - tax;
                    await supabase.from('players').update({ money: myM - amt }).eq('account_id', sId);
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', tg).single();
                    if (rc) await supabase.from('players').update({ money: rc.money + rAmt }).eq('account_id', tg);
                    else await supabase.from('players').insert({ account_id: tg, money: rAmt, debt: 0 });
                    return sendTempMessage(rid, `[info]🎁 [piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(amt)} 送金(税${fNum(tax)}引かれ、${fNum(rAmt)} 届きました)[/info]`);
                }
            }

            if (body.trim() === '/status') {
                const rem = Math.max(0, 5 + (player?.extra_slots||0) - (player?.slot_count||0));
                return sendTempMessage(rid, `[info][title]📊 状態[/title][piconname:${sId}]\n💰所持: ${fNum(myM)}\n💳借金: -${fNum(myD)}\n💎純資産: ${fNum(myM - myD)}\n[hr]👔職業: ${myJ}\n🎰スロット残: ${rem} 回\n💼お仕事残: ${player?.work_limit||0} 回\n⛩️運勢: ${player?.omikuji_result || '未引'}[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰純資産: ${fNum(net)} ${d.debt>0 ? `(借:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTempMessage(rid, `[info][title]👑 純資産ランキング[/title]${s}[/info]`, 300000);
            }

            // --- 💼 職業・スキル ---
            const cJobM = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|タイムトラベラー|td|マスター|賭博師)/);
            if (cJobM && gambleActive) {
                let jn = cJobM[2]; if(jn==='td') jn='タイムトラベラー';
                const cs = {'サラリーマン':0, '公務員':2000, '警察官':3000, 'プロスポーツ選手':5000, '賭博師':100000, 'マスター':700000, 'タイムトラベラー':1000000};
                if (myJ === jn) return sendTempMessage(rid, `[info]⚠️ すでに ${jn} です！[/info]`);
                if (myM < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ お金が足りません(費用: ${fNum(cs[jn])})[/info]`);
                if (player) await supabase.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                else await supabase.from('players').insert({ account_id: sId, job: jn, money: -cs[jn] });
                return sendTempMessage(rid, `[info]🎉 [piconname:${sId}]\n「${jn}」に転職しました！ (-${fNum(cs[jn])})[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(rid, `[info][title]💼 ハローワーク[/title]
👨‍💼 サラリーマン(0) ➡ /work (100〜500) ※10%でミス
🏛️ 公務員(2000) ➡ /work (300〜500)
🚓 警察官(3000) ➡ /work (300〜700) /catch (30%で800)
⚽ プロスポーツ選手(5000) ➡ /work (500〜1000) /goal (30%で1000)
🎲 賭博師(10万) ➡ /work (3000〜5000) /boostslot (スロット上限5〜10回増)
🎩 マスター(70万) ➡ /work (1万〜1万5千) /changemaster (50%で30分間他人の敗北額の50%を吸収)
⏳ タイムトラベラー(100万) ➡ /work (1.5万〜2万) /過去改変 (5分前の状態に戻す) /未来改変 (次のゲームが80%で当たる)
[hr]※転職: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive && player) {
                if (player.work_limit <= 0) return sendTempMessage(rid, `[info]⚠️ 本日の仕事回数が上限です。[/info]`);
                if (Date.now() - (player.last_work_time || 0) < 600000) return sendTempMessage(rid, `[info]⚠️ 休憩中です！(10分間隔)[/info]`);
                let e = 0, m = "";
                if(myJ === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="ミスをして給料 0 コインに..."; } else { e=Math.floor(Math.random()*401)+100; m=`${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJ === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJ === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJ === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`${fNum(e)} コイン稼ぎました！⚽`; }
                else if(myJ === '賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`${fNum(e)} コイン稼ぎました！🎲`; }
                else if(myJ === 'マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`${fNum(e)} コイン稼ぎました！🎩`; }
                else if(myJ === 'タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`${fNum(e)} コイン稼ぎました！⏳`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', sId);
                await addMoneyWithRepay(sId, e); 
                return sendTempMessage(rid, `[info][title]💼 お仕事完了[/title][piconname:${sId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            // 特殊能力
            if (/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/.test(body) && gambleActive && player) {
                let sk = body.match(/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/)[2];
                if (sk==='catch'&&myJ!=='警察官') return; if (sk==='goal'&&myJ!=='プロスポーツ選手') return;
                if (sk==='boostslot'&&myJ!=='賭博師') return; if (sk==='changemaster'&&myJ!=='マスター') return;
                if ((sk==='過去改変'||sk==='未来改変')&&myJ!=='タイムトラベラー') return;
                
                if (player.skill_date === today) return sendTempMessage(rid, `[info]⚠️ 今日の特殊能力は使用済みです！[/info]`);
                
                let msg = "";
                if (sk === 'catch') { let s=Math.random()<0.3; let e=s?800:0; if(s) { msg=`逮捕！特別報酬 ${e} 獲得！🚨`; await addMoneyWithRepay(sId, e); } else msg=`逃しました...🏃‍♂️`; }
                else if (sk === 'goal') { let s=Math.random()<0.3; let e=s?1000:0; if(s) { msg=`スーパーゴール！ ${e} 獲得！🥅`; await addMoneyWithRepay(sId, e); } else msg=`シュートは外れました...🤦‍♂️`; }
                else if (sk === 'boostslot') { let ex = Math.floor(Math.random()*6)+5; await supabase.from('players').update({ extra_slots: player.extra_slots + ex }).eq('account_id', sId); msg=`スロット上限が ${ex} 回増えました！🎲`; }
                else if (sk === 'changemaster') {
                    if (Math.random() < 0.5) { await supabase.from('config').upsert({ key: 'master_buff', value: JSON.stringify({ aid: sId, expire: Date.now() + 1800000 }) }); msg=`成功！30分間、他人が負けた額の50%を吸収します！🎩`; }
                    else { msg = `失敗...今日は調子が悪いようです。`; }
                }
                else if (sk === '未来改変') { await supabase.from('config').upsert({ key: 'mirai_buff', value: sId }); msg=`✨ 次のゲームで80%の確率で当たるように未来を書き換えました...！⏳`; }
                else if (sk === '過去改変') {
                    const { data: hD } = await supabase.from('config').select('value').eq('key', 'money_history').single();
                    if (hD) {
                        let h = JSON.parse(hD.value);
                        if (h.length > 0) {
                            let old = h[0].players;
                            for (let op of old) { await supabase.from('players').update({ money: op.money }).eq('account_id', op.account_id); }
                            msg=`🕰️ 過去を改変し、5分前の状態（賭けがなかった世界）に戻しました...！`;
                        } else msg=`戻すべき過去の記録がありませんでした...`;
                    }
                }
                await supabase.from('players').update({ skill_date: today }).eq('account_id', sId);
                return sendTempMessage(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}]\n${msg}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive && player) {
                let maxS = 5 + (player.extra_slots || 0);
                if (player.slot_count >= maxS) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 120000) return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nスロット休憩中(2分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? myMoney : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                if (bet > 99999) return sendTempMessage(rid, "⚠️ 賭け上限は 99999 コインです！");
                
                if (bet > 0 && myMoney >= bet) {
                    await supabase.from('players').update({ money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', sId);
                    
                    let r = Math.random() * 100, omi = (player.omikuji_date === today) ? player.omikuji_result : null, oM = "";
                    let isMirai = await consumeMiraiBuff(sId);
                    if (isMirai) { r = 0; oM = "(🌟未来改変!)"; }
                    else {
                        if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉!)"; } 
                        else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉)"; } 
                        else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=30; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (30倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; if (wA > 0) await addMoneyWithRepay(sId, wA); else await applyMasterTax(bet);
                    return sendMessage(rid, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(bet)} ➡ 獲得: ${fNum(wA)} コイン\n(残り: ${maxS - (player.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTempMessage(rid, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ 
                            let s = ((rs+i) % (10000-cnt)) + 1; 
                            let ok = true; 
                            for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } 
                            if(ok){ st=s; break; } 
                        }
                        if(st === -1) return sendTempMessage(rid, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(rid, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } 
                        mN = av.slice(0, cnt);
                    }
                    
                    await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', sId);
                    for (let n of mN) tks.push({ aid: sId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 テーブルゲーム ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby|bj)\b/) && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                
                let t = body.includes('/derby') ? 'derby' : (body.includes('/cc') ? 'cc' : (body.includes('/bj') ? 'bj' : 'chouhan'));
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : (t==='cc' ? "🎲 チンチロリン" : (t==='bj' ? "🃏 ブラックジャック" : "🎲 丁半ゲーム")); 
                let ex = t==='derby' ? "[code]/join derby[/code]" : (t==='cc' ? "[code]/join cc[/code]" : (t==='bj' ? "[code]/join bj[/code]" : "[code]/join chouhan[/code]"));
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; 
                    gameState[roomId].oddsStr = dO.oddsStr; 
                    gameState[roomId].st = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※ホストが /start${t==='chouhan'?'chouhan':t} で開始します。[/info]`); 
                return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby|bj)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) { 
                    gameState[roomId].players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby|bj)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                if (gameState[roomId].players.length < 2 && gameState[roomId].type !== 'bj') return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                gameState[roomId].state = 'BETTING';
                let ex = gameState[roomId].type === 'derby' ? `\n【 🐎 馬連オッズ 】\n${gameState[roomId].oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)` : `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※ /bet max や /bet half も使えます)[/info]`);
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gameState[roomId]) {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; 
                    gameState[roomId].players.splice(idx, 1);
                    if (p.bet > 0) await addMoneyWithRepay(senderId, p.bet); // 返金
                    
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。[/info]`);
                    if (gameState[roomId].players.length === 0) { 
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            // --- 🎲 ベット ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10));
                    if (b > 99999) return sendTempMessage(roomId, `[info]⚠️ 賭け金の上限は 99,999 コインです！[/info]`);
                    
                    if (b > 0 && myMoney >= b) {
                        if (gameState[roomId].type === 'derby') {
                            let h = bM[3]; 
                            if (!h || !gameState[roomId].oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            pl.choice = h;
                        }
                        pl.bet = b; 
                        await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${fNum(b)} コインをベットしました！[/info]`);
                        checkGameProgress(roomId);
                    } else sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
                }
                return;
            }

            // --- 🎲 アクション ---
            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().slice(1); 
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    checkGameProgress(roomId); 
                }
            }

            if (body.trim() === '/roll' && gambleActive && gameState[roomId]?.type === 'cc' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.res && senderId !== gameState[roomId].host) {
                    pl.res = getChinchiroRoll(); 
                    sendMessage(roomId, `[info]🎲 [piconname:${senderId}] の出目: ${pl.res.n}[/info]`); 
                    checkGameProgress(roomId);
                }
            }

            if ((body.trim() === '/hit' || body.trim() === '/stand') && gambleActive && gameState[roomId]?.type === 'bj' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (body.trim() === '/hit') {
                        let c = g.deck.pop(); pl.hand.push(c);
                        let score = calcBJScore(pl.hand); let hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        if (score > 21) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else if (score === 21) {
                            pl.status = 'stand';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n\n👉 [code]/hit[/code] または [code]/stand[/code][/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else {
                        pl.status = 'stand'; let score = calcBJScore(pl.hand);
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。 (スコア: ${score})[/info]`);
                        g.turnIndex++; await proceedNextBJTurn(roomId);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

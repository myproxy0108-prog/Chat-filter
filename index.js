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

let betLogs = [];   // /KK (タイムトラベル) 用の過去5分ログ
let cmState = null; // /cm (マスター) の吸収状態 { aid, expire }
let mkState = null; // /MK (タイムトラベル) のイカサマ状態 { aid }

supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

// --- Date Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- Chatwork Messages ---
const makeRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendMessage = async (rid, txt) => {
    try { await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`); } catch(e){}
};

const sendTempMessage = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) {
            setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
        }
    } catch(e) {}
};

// --- お金・ログ管理 ---
const logBet = (aid, diff) => {
    if (diff === 0) return;
    betLogs.push({ aid, diff, t: Date.now() });
    betLogs = betLogs.filter(l => Date.now() - l.t <= 300000); // 5分以内のみ保持
};

const addMoneyWithRepay = async (aid, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let money = p ? p.money : 0;
    let debt = p ? (p.debt || 0) : 0;

    if (debt > 0 && amount > 0) {
        let repay = Math.min(debt, amount);
        debt -= repay; amount -= repay;
    }
    money += amount;

    if (p) {
        await supabase.from('players').update({ money, debt }).eq('account_id', aid);
    } else {
        await supabase.from('players').insert({ account_id: aid, money, debt, slot_count: 0, work_limit: 5, msg_count: 0, slot_limit: 5, job: 'サラリーマン' });
    }
};

const applyCM = async (lossAmt) => {
    if (cmState && Date.now() < cmState.expire && lossAmt > 0) {
        let absorb = Math.floor(lossAmt * 0.5);
        if (absorb > 0) {
            await addMoneyWithRepay(cmState.aid, absorb);
            logBet(cmState.aid, absorb);
        }
    }
};

// --- 管理・防衛機能 ---
const isUserAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTarget = async (rid, targetAids, action = 'readonly') => {
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

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        await cw.put(`/rooms/${rid}/members`, params.toString());
    } catch(e) {}
};

const checkSpam = (aid) => {
    const now = Date.now();
    if (!spamRecords[aid]) spamRecords[aid] = [];
    spamRecords[aid].push(now);
    spamRecords[aid] = spamRecords[aid].filter(t => now - t <= 5000);
    return (spamRecords[aid].length >= 10);
};

// --- ゲームエンジン ---
const generateDerby = () => {
    let stats = []; for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0;
    let oddsMap = {}, oddsStr = "";
    
    for(let i=1; i<=5; i++){
        for(let j=i+1; j<=6; j++){
            let w = stats[i-1] * stats[j-1];
            combos.push({ c: `${i}-${j}`, w });
            totalWeight += w;
        }
    }
    
    combos.forEach(c => {
        let odd = (0.8 / (c.w / totalWeight)).toFixed(1);
        if (odd < 1.1) odd = 1.1; if (odd > 150) odd = 150.0;
        oddsMap[c.c] = Number(odd);
    });
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => { oddsStr += `🐎 ${k} : [code]${oddsMap[k]}倍[/code]\n`; });
    return { oddsMap, oddsStr, stats };
};

const getDeck = () => {
    const suits = ['♠','♥','♣','♦'], ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for (let s of suits) for (let i = 0; i < ranks.length; i++) deck.push({ s, r: ranks[i], v: i + 2 });
    for (let i = deck.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [deck[i], deck[r]] = [deck[r], deck[i]]; }
    return deck;
};

const evalPoker = (cards) => {
    let v = cards.map(c => c.v).sort((a, b) => b - a); 
    let s = cards.map(c => c.s);
    let isFlush = s.every(x => x === s[0]), isStraight = false, straightHigh = 0;
    
    if (v[0] - v[4] === 4 && new Set(v).size === 5) { isStraight = true; straightHigh = v[0]; }
    else if (v.join(',') === "14,5,4,3,2") { isStraight = true; straightHigh = 5; } 
    
    let counts = {}; v.forEach(x => counts[x] = (counts[x]||0) + 1);
    let cArr = Object.keys(counts).map(k => [parseInt(k), counts[k]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    
    let rank = 1, tieBreak = [];
    if (isFlush && isStraight) {
        if (straightHigh === 14) { rank = 10; tieBreak = [14]; } else { rank = 9; tieBreak = [straightHigh]; } 
    } else if (cArr[0][1] === 4) { rank = 8; tieBreak = [cArr[0][0], cArr[1][0]]; 
    } else if (cArr[0][1] === 3 && cArr[1][1] === 2) { rank = 7; tieBreak = [cArr[0][0], cArr[1][0]]; 
    } else if (isFlush) { rank = 6; tieBreak = v; 
    } else if (isStraight) { rank = 5; tieBreak = [straightHigh]; 
    } else if (cArr[0][1] === 3) { rank = 4; tieBreak = [cArr[0][0], cArr[1][0], cArr[2][0]]; 
    } else if (cArr[0][1] === 2 && cArr[1][1] === 2) { rank = 3; tieBreak = [cArr[0][0], cArr[1][0], cArr[2][0]]; 
    } else if (cArr[0][1] === 2) { rank = 2; tieBreak = [cArr[0][0], cArr[1][0], cArr[2][0], cArr[3][0]]; 
    } else { rank = 1; tieBreak = v; } 
    
    const names = ["", "ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ", "ロイヤルフラッシュ"];
    const mults = [1, 1, 1, 2, 3, 4, 5, 10, 20, 50, 100]; 
    return { r: rank, n: names[rank], m: mults[rank], tb: tieBreak };
};

const comparePoker = (p1, p2) => {
    if (p1.r > p2.r) return 1; if (p1.r < p2.r) return -1;
    for (let i = 0; i < p1.tb.length; i++) { if (p1.tb[i] > p2.tb[i]) return 1; if (p1.tb[i] < p2.tb[i]) return -1; }
    return 0; 
};

const drawPoker = (deck) => {
    let hand = []; for(let i=0; i<5; i++) hand.push(deck.pop());
    return { hand, ...evalPoker(hand) };
};

// --- ゲーム進行 (タイマー無し・全員完了で即精算) ---
const checkGameProgress = async (rid) => {
    let game = gameState[rid]; if (!game || game.state === 'IDLE') return;

    if (game.state === 'BETTING' && game.players.length >= 2 && game.players.every(p => p.bet > 0)) {
        if (game.type === 'derby') {
            await resolveDerby(rid);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "親以外は [code]/draw[/code] でカードを引いてください！";
            await sendTempMessage(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}[/info]`);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.length >= 2 && game.players.every(p => p.choice)) await resolveChouhan(rid);
        if (game.type === 'poker' && game.players.length >= 2 && game.players.filter(x => x.aid !== game.host).every(p => p.res)) await resolvePoker(rid);
    }
};

// --- ゲーム結果精算 ---
const resolvePoker = async (rid) => {
    let game = gameState[rid]; if (!game) return;
    
    let botRes = drawPoker(game.deck); 
    // MK能力 (タイムトラベラー) があれば80%で発動
    if (mkState) {
        let mkP = game.players.find(p => p.aid === mkState.aid);
        if (mkP && Math.random() < 0.8) {
            mkP.res = { r: 10, n: "ロイヤルストレートフラッシュ", m: 100, hand: [], tb: [14] };
        }
        mkState = null;
    }

    let msg = `[info][title]🃏 ポーカー 結果発表[/title]【 親 ([piconname:${game.host}]) の手札 】\n[ ${botRes.hand.map(c=>c.s+c.r).join(' ')} ] ➡ 『 ${botRes.n} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of game.players) {
        if (p.aid === game.host) continue;
        let r = p.res || { r: -1, n: "欠席", m: 1, hand: [] };
        if (r.r === -1) { 
            msg += `💀 [piconname:${p.aid}]: 欠席 (没収)\n`; 
            await applyCM(p.bet);
            continue; 
        }
        
        let win = (r.r > botRes.r) || (r.r === botRes.r && comparePoker(r, botRes) > 0);
        let draw = (r.r === botRes.r && comparePoker(r, botRes) === 0);
        
        if (draw) { 
            await addMoneyWithRepay(p.aid, p.bet); logBet(p.aid, p.bet);
            msg += `😐 [piconname:${p.aid}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 引き分け (返金)\n`; 
        } else if (win) { 
            let mult = r.m > 0 ? r.m : 1; 
            let winAmt = p.bet + (p.bet * mult);
            await addMoneyWithRepay(p.aid, winAmt); logBet(p.aid, winAmt);
            msg += `(cracker) [piconname:${p.aid}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 勝ち！ (+${fNum(p.bet * mult)})\n`; 
        } else { 
            msg += `💀 [piconname:${p.aid}]: [${r.hand.map(c=>c.s+c.r).join(' ')}] ${r.n} ➡ 負け...\n`; 
            await applyCM(p.bet);
        }
    }
    await sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; 
};

const resolveChouhan = async (rid) => {
    let game = gameState[rid]; if (!game) return;
    
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1;
    let sum = d1 + d2, result = (sum % 2 === 0) ? 'chou' : 'han';
    
    if (mkState) {
        let mkP = game.players.find(p => p.aid === mkState.aid);
        if (mkP && Math.random() < 0.8) {
            result = mkP.choice;
            if (result === 'chou') { d1 = 2; d2 = 2; sum = 4; } else { d1 = 1; d2 = 2; sum = 3; }
        }
        mkState = null;
    }

    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of game.players) {
        if (p.choice === result) { 
            let winAmt = p.bet * 2;
            await addMoneyWithRepay(p.aid, winAmt); logBet(p.aid, winAmt);
            msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(winAmt)} コイン)\n`; 
        } else { 
            msg += `💀 [piconname:${p.aid}]: 予想[${p.choice === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; 
            await applyCM(p.bet);
        }
    }
    await sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; 
};

const resolveDerby = async (rid) => {
    let game = gameState[rid]; if (!game) return;
    
    let stats = game.st, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
    let r1 = Math.random() * totalW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    
    ws[first-1] = 0; totalW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * totalW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`;
    
    if (mkState) {
        let mkP = game.players.find(p => p.aid === mkState.aid);
        if (mkP && Math.random() < 0.8) {
            winCombo = mkP.choice;
            let parts = winCombo.split('-'); first = parseInt(parts[0]); second = parseInt(parts[1]);
        }
        mkState = null;
    }

    let odd = game.oddsMap[winCombo];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    
    for(let p of game.players){
        if(p.choice === winCombo){ 
            let winAmt = Math.floor(p.bet * odd); 
            await addMoneyWithRepay(p.aid, p.bet + winAmt); logBet(p.aid, p.bet + winAmt);
            msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(winAmt)} コイン)\n`; 
        } else { 
            msg += `💀 [piconname:${p.aid}]: 予想[${p.choice}] ➡ はずれ...\n`; 
            await applyCM(p.bet);
        }
    }
    await sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; 
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || ev.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id;
    const body = ev.body || "";
    const senderId = ev.account_id.toString();
    const msgId = ev.message_id;
    const today = getTodayStr(), thisMonth = getThisMonthStr();

    (async () => {
        try {
            // --- 返信タグの解析 ---
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. ブラックリスト防衛
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { 
                await kickTarget(roomId, [senderId], 'readonly'); 
                await cw.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{}); 
                return; 
            }

            // 2. スパム（連投）防衛
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await kickTarget(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 3. 深夜0時リセット & 宝くじ抽選
            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    // スロット回数、おみくじ、仕事制限、さらに「賭博師の拡張スロット上限(slot_limit)」もデフォルトの5に戻す
                    await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null, slot_limit: 5 }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    
                    let resetMsg = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事・能力制限がリセットされました！\n[hr]`;
                    
                    const { data: tData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = tData ? JSON.parse(tData.value) : [];
                    if (tickets.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let payouts = {}; let winners = [];
                        
                        const checkPrize = (n, w) => {
                            if (n === w) return { p: 30000, name: '🥇 1等' };
                            let prev = w - 1 < 1 ? 9999 : w - 1, next = w + 1 > 9999 ? 1 : w + 1;
                            if (n === prev || n === next) return { p: 15000, name: '🥈 前後賞' };
                            if (n % 1000 === w % 1000) return { p: 10000, name: '🥈 2等' }; 
                            if (n % 100 === w % 100) return { p: 5000, name: '🥉 3等' };    
                            if (n % 10 === w % 10) return { p: 1000, name: '🏅 4等' };      
                            return null;
                        };
                        
                        for (let t of tickets) { 
                            let r = checkPrize(t.num, win); 
                            if(r) { winners.push({ a: t.aid, num: t.num, ...r }); payouts[t.aid] = (payouts[t.aid] || 0) + r.p; } 
                        }
                        
                        if (winners.length > 0) {
                            for (let aid in payouts) await addMoneyWithRepay(aid, payouts[aid]);
                            winners.sort((a,b) => b.p - a.p); 
                            for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${fNum(w.p)} コイン)\n`;
                            if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                        } else {
                            resetMsg += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        }
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMessage(roomId, resetMsg + `[/info]`);
                }
            }

            // 4. プレイヤーデータ取得 & 仕事回数サイレント回復
            let { data: player } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (!player && gambleActive && !body.startsWith('/')) {
                await supabase.from('players').insert({ account_id: senderId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 1, slot_limit: 5, job: 'サラリーマン' });
                player = { money: 0, debt: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン', slot_count: 0, slot_limit: 5 };
            }
            
            if (gambleActive && player && !body.startsWith('/')) {
                let mc = (player.msg_count || 0) + 1; 
                let wl = player.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
            }

            let myMoney = player ? player.money : 0;
            let myDebt = player ? (player.debt || 0) : 0;
            let myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';
            let currentMonthlyDebt = (player && player.debt_month === thisMonth) ? (player.monthly_debt || 0) : 0;
            let mySlotLimit = player ? (player.slot_limit || 5) : 5;

            // --- 📖 ヘルプコマンド ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V41 FINAL)[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (10分に1回, 1日5回上限)
・ [code]/catch[/code], [code]/goal[/code], [code]/cm[/code], [code]/slot-up[/code], [code]/KK[/code], [code]/MK[/code] : 職業専用の特殊能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (2分間隔、上限99,999)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム (時間制限・待機なし) 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/poker[/code] : ポーカー募集 ([code]/draw[/code] でカードを引く)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬連][/code])
※全員のアクション完了で即精算されます。放置用: [code]/leave[/code] または [code]/fi-game[/code]

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : 進行中のゲームを強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効/無効化
・ [code]/blacklist[/code], [code]/remove-rank[/code] 等[/info]`;
                return sendTempMessage(roomId, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let targetAid = repliedAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (targetAid && amt > 0) { 
                    await addMoneyWithRepay(targetAid, amt); 
                    return sendTempMessage(roomId, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${targetAid}] 様へ ${fNum(amt)} コインを付与しました。[/info]`); 
                }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                if (gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                    for (let p of gameState[roomId].players) if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                    if (gameState[roomId].timeoutId) clearTimeout(gameState[roomId].timeoutId); 
                    if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                    gameState[roomId] = null; 
                    return sendTempMessage(roomId, `[info]⚠️ 管理者により進行中のゲームが強制終了・全額返金されました。[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!targetAid && cmd !== 'add') return; 
                if (!targetAid && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(targetAid)) { 
                        ex = ex.filter(i => i !== targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様のランキング除外を解除しました。[/info]`); 
                    } else { 
                        ex.push(targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様をランキングから除外しました。[/info]`); 
                    }
                    return await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                
                if (cmd === 'add') { 
                    await supabase.from('blacklist').insert({account_id: targetAid}); 
                    await kickTarget(roomId, [targetAid], 'readonly'); 
                    return sendTempMessage(roomId, `[info][title]🚫 追放完了[/title][piconname:${targetAid}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`); 
                } else if (cmd === 'remove') { 
                    await supabase.from('blacklist').delete().eq('account_id', targetAid); 
                    return sendTempMessage(roomId, `[info][title]✅ 解除完了[/title][piconname:${targetAid}] の追放状態を解除しました。[/info]`); 
                } else if (cmd === 'list') { 
                    const { data: ls } = await supabase.from('blacklist').select('account_id'); 
                    const listStr = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし";
                    return sendTempMessage(roomId, `[info][title]📜 ブラックリスト一覧[/title]${listStr}\n[hr]※1分後に自動消滅します[/info]`); 
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); 
                return sendMessage(roomId, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); 
            }
            if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); 
                return sendMessage(roomId, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); 
            }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (player && player.omikuji_date === today) return sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeRp(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${player.omikuji_result})[/info]`);
                
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP (0.5%)】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP (0.3%)】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通り(0.1%)です。"; } 
                else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通り(0.1%)です。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
                else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN (0.01%)】..."; }
                
                if (player) await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, money: 0, debt: 0, omikuji_date: today, omikuji_result: res });
                
                return sendMessage(roomId, `[info][title]⛩️ おみくじ結果[/title]${makeRp(senderId, roomId, msgId)}\n[hr]今日の運勢は...【 ${res} 】！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 (借金・送金) ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (currentMonthlyDebt + amt > 5000) return sendTempMessage(roomId, `[info][title]⚠️ 借金上限エラー[/title]${makeRp(senderId, roomId, msgId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${currentMonthlyDebt} コイン借りています)[/info]`);
                    
                    if (player) await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    else await supabase.from('players').insert({ account_id: senderId, money: amt, debt: amt, monthly_debt: amt, debt_month: thisMonth });
                    
                    return sendTempMessage(roomId, `[info][title]💳 お借り入れ完了[/title][piconname:${senderId}] 様\n${fNum(amt)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (currentMonthlyDebt + amt))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                
                if (targetAid && amt > 0) {
                    let av = Math.max(0, myMoney - myDebt); 
                    if (av < amt) return sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeRp(senderId, roomId, msgId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${fNum(av)} コインのみです)[/info]`);
                    
                    let tax = Math.floor(amt * 0.10); let rAmt = amt - tax;
                    await supabase.from('players').update({ money: myMoney - amt }).eq('account_id', senderId);
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                    if (rc) await supabase.from('players').update({ money: rc.money + rAmt }).eq('account_id', targetAid);
                    else await supabase.from('players').insert({ account_id: targetAid, money: rAmt, debt: 0 });
                    
                    return sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${fNum(amt)} コインを送金しました。\n[hr]※システム税 10% (${fNum(tax)} コイン) が引かれ、相手には ${fNum(rAmt)} コインが届きました。[/info]`);
                }
            }

            // --- 📊 ステータス & ランキング ---
            if (body.trim() === '/status') {
                if (player) {
                    const remSlot = Math.max(0, mySlotLimit - player.slot_count);
                    const dStr = myDebt > 0 ? `\n💳 借金: -${fNum(myDebt)} コイン` : '';
                    return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${fNum(myMoney)} コイン${dStr}\n💎 純資産: ${fNum(myMoney - myDebt)} コイン\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${player.work_limit} 回\n⛩️ 今日の運勢: ${player.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
                } else return sendTempMessage(roomId, `[info]データがありません。[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); 
                    let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(net)} コイン ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                
                return sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; 
                const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, '賭博師': 100000, 'マスター': 700000, 'タイムトラベラー': 1000000};
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                
                if (player) await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, job: jn, money: -cs[jn] });
                
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (0) ➡ [code]/work[/code] (100〜500) ※10%でミス0
🏛️ 公務員 (2,000) ➡ [code]/work[/code] (300〜500)
🚓 警察官 (3,000) ➡ [code]/work[/code] (300〜700) ＆ [code]/catch[/code]
⚽ プロスポーツ (5,000) ➡ [code]/work[/code] (500〜1000) ＆ [code]/goal[/code]
🎲 賭博師 (100,000) ➡ [code]/work[/code] (3000〜5000) ＆ [code]/slot-up[/code]
🔮 マスター (700,000) ➡ [code]/work[/code] (10000〜15000) ＆ [code]/cm[/code]
⏳ タイムトラベラー (1,000,000) ➡ [code]/work[/code] (15000〜20000) ＆ [code]/KK[/code], [code]/MK[/code]
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive && player) {
                if (player.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (player.last_work_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${fNum(e)} コイン稼ぎました！⚽`; }
                else if(myJob === '賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`ギャンブルの合間に、 ${fNum(e)} コイン稼ぎました！🎲`; }
                else if(myJob === 'マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`究極の指導を行い、 ${fNum(e)} コイン稼ぎました！🔮`; }
                else if(myJob === 'タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`時空を超えて、 ${fNum(e)} コインを調達しました！⏳`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            // --- 🌟 職業 特殊能力 ---
            if (/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/.test(body) && gambleActive && player) {
                let cmd = body.match(/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/)[2];
                
                if (cmd === 'catch' && myJob !== '警察官') return;
                if (cmd === 'goal' && myJob !== 'プロスポーツ選手') return;
                if (cmd === 'slot-up' && myJob !== '賭博師') return;
                if (cmd === 'cm' && myJob !== 'マスター') return;
                if ((cmd === 'KK' || cmd === 'MK') && myJob !== 'タイムトラベラー') return;

                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                
                let msg = "";
                if (cmd === 'catch') {
                    if (Math.random() < 0.3) { await addMoneyWithRepay(senderId, 800); msg = `犯人を逮捕しました！特別報酬 800 コイン獲得！🚨`; }
                    else msg = `犯人を逃してしまいました...🏃‍♂️💨`;
                } else if (cmd === 'goal') {
                    if (Math.random() < 0.3) { await addMoneyWithRepay(senderId, 1000); msg = `スーパーゴールを決めました！特別報酬 1000 コイン獲得！🥅✨`; }
                    else msg = `シュートは外れてしまいました...🤦‍♂️`;
                } else if (cmd === 'slot-up') {
                    let newLimit = Math.floor(Math.random() * 6) + 10; // 10〜15
                    await supabase.from('players').update({ slot_limit: newLimit }).eq('account_id', senderId);
                    msg = `ギャンブル魂が燃え上がった！🔥 本日のスロット上限が ${newLimit} 回になりました！`;
                } else if (cmd === 'cm') {
                    if (Math.random() < 0.5) {
                        cmState = { aid: senderId, expire: Date.now() + 30 * 60000 };
                        msg = `マスターのオーラを展開！🔮\nここから30分間、他人がギャンブルで負けた額の50%を吸収します！`;
                    } else msg = `オーラの展開に失敗しました...今日はもう使えません。💦`;
                } else if (cmd === 'MK') {
                    mkState = { aid: senderId };
                    msg = `未来予知完了...👁️✨\n次に行われるゲームで、あなたに80%の確率で「奇跡」が起こります！`;
                } else if (cmd === 'KK') {
                    let now = Date.now();
                    let targets = betLogs.filter(l => now - l.t <= 300000);
                    let diffs = {};
                    for (let l of targets) { if (!diffs[l.aid]) diffs[l.aid] = 0; diffs[l.aid] -= l.diff; } // 巻き戻し
                    for (let aid in diffs) { if (diffs[aid] !== 0) await addMoneyWithRepay(aid, diffs[aid]); }
                    betLogs = []; cmState = null; mkState = null;
                    msg = `⏳ タイムトラベル発動！\n過去5分間にあった全てのギャンブル結果を「なかったこと」にしました！（全プレイヤーの損益が巻き戻りました）`;
                }
                
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}] 様\n\n${msg}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive && player) {
                if (player.slot_count >= mySlotLimit) return sendTempMessage(roomId, `[info]⚠️ ${mkRp(senderId, roomId, msgId)}\n本日のスロットは上限(${mySlotLimit}回)に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 120000) return sendTempMessage(roomId, `[info]⚠️ ${mkRp(senderId, roomId, msgId)}\nスロット休憩中(2分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? myMoney : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                bet = Math.min(bet, 99999); // 上限99999
                
                if (bet > 0 && myMoney >= bet) {
                    await supabase.from('players').update({ money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', senderId);
                    logBet(senderId, -bet); // 賭けログ
                    
                    let r = Math.random() * 100, omi = (player.omikuji_date === today) ? player.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } else if(omi === '大凶') { r += 0.09; }
                    
                    // スロットのMK発動
                    if (mkState && mkState.aid === senderId && Math.random() < 0.8) { r = 0.05; mkState = null; oM = "(👁️MK発動!)"; }

                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=30; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (30倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; 
                    if (wA > 0) { await addMoneyWithRepay(senderId, wA); logBet(senderId, wA); }
                    else await applyCM(bet); // ハズレたらCM吸収判定
                    
                    return sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${mkRp(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(bet)} ➡ 獲得: ${fNum(wA)} コイン\n(残り回数: ${mySlotLimit - (player.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ ${mkRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    
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
                        if(st === -1) return sendTempMessage(roomId, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(roomId, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } 
                        mN = av.slice(0, cnt);
                    }
                    
                    await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', senderId);
                    for (let n of mN) tks.push({ aid: senderId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${senderId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 テーブルゲーム (タイマーなし・手動進行) ---
            if (body.match(/(^|\n)\/(chouhan|poker|derby)\b/) && gambleActive) {
                if (gameState[roomId] && gameState[roomId].state !== 'IDLE') return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。[/info]`);
                
                let t = body.includes('/derby') ? 'derby' : (body.includes('/poker') ? 'poker' : 'chouhan');
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : (t==='poker' ? "🃏 ポーカー" : "🎲 丁半ゲーム"); 
                let ex = t==='derby' ? "[code]/join derby[/code]" : (t==='poker' ? "[code]/join poker[/code]" : "[code]/join chouhan[/code]");
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; gameState[roomId].oddsStr = dO.oddsStr; gameState[roomId].st = dO.stats;
                }
                if (t === 'poker') { gameState[roomId].deck = getDeck(); }
                
                return sendMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]ホストが [code]/start${t==='chouhan'?'chouhan':(t==='poker'?'poker':'derby')}[/code] と打つとゲームが進行します。[/info]`); 
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|poker|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) { 
                    gameState[roomId].players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
                }
                return;
            }

            // ホストによる手動開始
            if (body.match(/(^|\n)\/start(chouhan|poker|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                if (gameState[roomId].players.length < 2) return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                
                gameState[roomId].state = 'BETTING';
                if (gameState[roomId].type === 'derby') {
                    let ex = `\n【 🐎 馬連オッズ 】\n${gameState[roomId].oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                    await sendMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n${ex}\n[hr](※/bet max 等も可、上限99,999)[/info]`);
                } else {
                    let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                    await sendMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※/bet max 等も可、上限99,999)[/info]`);
                }
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; 
                    gameState[roomId].players.splice(idx, 1);
                    if (p.bet > 0) { await addMoneyWithRepay(senderId, p.bet); logBet(senderId, p.bet); } // 返金
                    
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。[/info]`);
                    if (gameState[roomId].players.length === 0) { 
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    await checkGameProgress(roomId);
                }
                return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10));
                    b = Math.min(b, 99999); // ★上限99,999
                    
                    if (b > 0 && myMoney >= b) {
                        if (gameState[roomId].type === 'derby') {
                            let h = bM[3]; 
                            if (!h || !gameState[roomId].oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            pl.choice = h;
                        }
                        pl.bet = b; 
                        await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                        logBet(senderId, -b); // マイナス記録
                        
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${fNum(b)} コインをベットしました！[/info]`);
                        await checkGameProgress(roomId);
                    } else sendTempMessage(roomId, `[info]⚠️ ${mkRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().slice(1); 
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    await checkGameProgress(roomId); 
                }
            }

            if (body.trim() === '/draw' && gambleActive && gameState[roomId]?.type === 'poker' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.res && senderId !== gameState[roomId].host) {
                    let hand = []; for(let i=0; i<5; i++) hand.push(gameState[roomId].deck.pop());
                    pl.res = { hand, ...evalPoker(hand) };
                    sendMessage(roomId, `[info]🃏 [piconname:${senderId}] の役: ${pl.res.n} [ ${pl.res.hand.map(c=>c.s+c.r).join(' ')} ][/info]`); 
                    await checkGameProgress(roomId);
                }
            }

        } catch (error) { console.error(error); }
    })();
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

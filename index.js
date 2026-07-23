

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const chatworkClient = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; 
const daifugoRooms = {}; 
let BOT_ACCOUNT_ID = null;

chatworkClient.get('/me').then(res => { BOT_ACCOUNT_ID = res.data.account_id.toString(); }).catch(()=>{});

let kabuData = { price: 1000, history: [1000], totalIssued: 0, lastUpdate: Date.now() };

supabase.from('config').select('*').in('key', ['gamble_active', 'kabu_data']).then(r => {
    if (r.data) {
        let ga = r.data.find(x => x.key === 'gamble_active');
        if (ga) gambleActive = ga.value === 'true';
        let kd = r.data.find(x => x.key === 'kabu_data');
        if (kd) kabuData = JSON.parse(kd.value);
    }
}).catch(()=>{});

const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNumber = (n) => Number(n).toLocaleString();
const sleep = ms => new Promise(res => setTimeout(res, ms));

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

const makeReplyTag = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const GAME_NAMES = {
    'derby': "🐎 みんなでダービー", 'cc': "🎲 チンチロリン", 'bj': "🃏 ブラックジャック",
    'poker': "🃏 ポーカー", 'yacht': "🎲 ヨット", 'sicbo': "🎲 シックボー(大小)",
    'rolet': "🎡 ルーレット", 'buta': "🐷 豚のしっぽ", 'daifugo': "👑 大富豪",
    'russian': "🔫 ロシアンルーレット", 'chouhan': "🎲 丁半ゲーム"
};

const sendMessage = async (roomId, text) => {
    try { await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`); } catch(e){}
};

const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res?.data?.message_id) setTimeout(() => chatworkClient.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

const playAnimation = async (roomId, initialText, getFrameText, frameCount, delay, finalMessage) => {
    try {
        let res = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(initialText)}`);
        if (res && res.data && res.data.message_id) {
            let mId = res.data.message_id;
            for (let i = 0; i < frameCount; i++) {
                await sleep(delay);
                await chatworkClient.put(`/rooms/${roomId}/messages/${mId}`, `body=${encodeURIComponent(getFrameText(i))}`);
            }
            if (finalMessage) {
                await sleep(600);
                await chatworkClient.put(`/rooms/${roomId}/messages/${mId}`, `body=${encodeURIComponent(finalMessage)}`);
            }
            return mId;
        }
    } catch(e) {}
    if (finalMessage) await sendMessage(roomId, finalMessage);
    return null;
};

const updateKabuPrice = async () => {
    let now = Date.now();
    let hoursPassed = Math.floor((now - kabuData.lastUpdate) / 3600000);
    if (hoursPassed > 0) {
        for (let i = 0; i < hoursPassed; i++) {
            let changePercent = (Math.random() * 0.2) - 0.1; 
            let r = Math.random();
            if (r < 0.05) changePercent = (Math.random() * 2.2) - 0.7; 
            else if (r < 0.25) changePercent = (Math.random() * 0.7) - 0.3; 
            kabuData.price += Math.floor(kabuData.price * changePercent);
            if (kabuData.price < 1000) kabuData.price = 1000;
            if (kabuData.price > 10000) kabuData.price = 10000;
            kabuData.history.push(kabuData.price);
        }
        kabuData.lastUpdate = now;
        if (kabuData.history.length > 24) kabuData.history = kabuData.history.slice(-24);
        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    }
};

const addMoneyWithRepay = async (accountId, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', accountId).single();
    let money = p ? (p.money || 0) : 0, debt = p ? (p.debt || 0) : 0, bank = p ? (p.bank || 0) : 0, kabu = p ? (p.kabu_owned || 0) : 0;
    let lastTime = p && p.last_interest_time ? Number(p.last_interest_time) : Date.now();
    let now = Date.now();
    if (debt > 0) {
        let daysPassed = Math.floor((now - lastTime) / 86400000);
        if (daysPassed > 0) {
            debt = Math.min(Math.floor(debt * Math.pow(1.005, daysPassed)), 990000);
            lastTime = lastTime + (daysPassed * 86400000);
        }
    } else lastTime = now;
    if (debt > 0 && amount > 0) { let repayAmount = Math.min(debt, amount); debt -= repayAmount; amount -= repayAmount; }
    money += amount;
    if (p) await supabase.from('players').update({ money, debt, last_interest_time: lastTime }).eq('account_id', accountId);
    else await supabase.from('players').insert({ account_id: accountId, money, bank, debt, last_interest_time: lastTime, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン', win_streak: 0, life_bet_unlocked: false, kabu_owned: kabu, plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0 });
};

const updatePlayerStats = async (accountId, betAmount, returnAmount, resultType) => {
    const { data: p } = await supabase.from('players').select('plays, wins, loses, total_bet, total_return').eq('account_id', accountId).single();
    if (!p) return;
    let plays = (p.plays || 0) + 1, wins = p.wins || 0, loses = p.loses || 0;
    if (resultType === 'win') wins++; else if (resultType === 'lose') loses++;
    await supabase.from('players').update({ plays, wins, loses, total_bet: (p.total_bet || 0) + Math.abs(betAmount), total_return: (p.total_return || 0) + Math.abs(returnAmount) }).eq('account_id', accountId);
};

const updateWinStreak = async (accountId, result, roomId) => {
    if (result === 'draw') return;
    const { data: p } = await supabase.from('players').select('win_streak').eq('account_id', accountId).single();
    if (!p) return;
    let streak = p.win_streak || 0;
    if (result === 'win') {
        streak++;
        let updates = { win_streak: streak };
        if (streak === 8) {
            updates.life_bet_unlocked = true;
            setTimeout(() => sendMessage(roomId, `[info][piconname:${accountId}]\nなんだろ…いまならいける気がする…\n(※次回のゲームで特別に /bet life が使用可能になりました！)[/info]`), 1000);
        }
        await supabase.from('players').update(updates).eq('account_id', accountId);
    } else if (result === 'lose') await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', accountId);
};

const isUserAdmin = async (roomId, accountId) => {
    try {
        const { data: members } = await chatworkClient.get(`/rooms/${roomId}/members`);
        const member = members.find(x => x.account_id.toString() === accountId.toString());
        return member && (member.role === 'admin' || member.role === 'creator');
    } catch(e) { return false; }
};

const updateRoomMembers = async (roomId, targetAids, action = 'readonly') => {
    try {
        const { data: membersList } = await chatworkClient.get(`/rooms/${roomId}/members`);
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
        await chatworkClient.put(`/rooms/${roomId}/members`, params.toString());
    } catch(e) {}
};

const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(time => now - time <= 5000);
    return (spamRecords[accountId].length >= 10);
};

// --- ゲームロジック ---
const isRouletteWin = (betChoice, resultNumber) => {
    if (betChoice === 'red') return [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(resultNumber);
    if (betChoice === 'black') return [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35].includes(resultNumber);
    if (betChoice === 'even') return resultNumber !== 0 && resultNumber % 2 === 0;
    if (betChoice === 'odd') return resultNumber % 2 !== 0;
    if (betChoice === 'high') return resultNumber >= 19 && resultNumber <= 36;
    if (betChoice === 'low') return resultNumber >= 1 && resultNumber <= 18;
    return parseInt(betChoice) === resultNumber;
};
const getRouletteMult = (c) => ['red','black','even','odd','high','low'].includes(c) ? 2 : 36;
const getRouletteColorStr = (num) => num === 0 ? "🟢緑" : ([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(num) ? "🔴赤" : "⚫黒");

const generateDerby = () => {
    let stats = []; for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0, oddsMap = {}, oddsStr = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = stats[i-1] * stats[j-1]; combos.push({ combo: `${i}-${j}`, weight: w }); totalWeight += w; } }
    combos.forEach(c => { let odd = (0.8 / (c.weight / totalWeight)).toFixed(1); oddsMap[c.combo] = odd < 1.1 ? 1.1 : (odd > 150 ? 150.0 : Number(odd)); });
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => { oddsStr += `🐎 ${k} : ${oddsMap[k]}倍\n`; });
    return { oddsMap, oddsStr, stats };
};

const generateChinchiroRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0]===1 && d[1]===1 && d[2]===1) return { dice:d, name: "ピンゾロ", rank: 6, score: 1, mult: 5 };
        if (d[0]===d[1] && d[1]===d[2]) return { dice:d, name: `${d[0]}の嵐`, rank: 5, score: d[0], mult: 3 };
        if (d[0]===4 && d[1]===5 && d[2]===6) return { dice:d, name: "シゴロ", rank: 4, score: 6, mult: 2 };
        if (d[0]===1 && d[1]===2 && d[2]===3) return { dice:d, name: "ヒフミ", rank: 0, score: 0, mult: -2 };
        if (d[0]===d[1]) return { dice:d, name: `${d[2]}の目`, rank: 2, score: d[2], mult: 1 };
        if (d[1]===d[2]) return { dice:d, name: `${d[0]}の目`, rank: 2, score: d[0], mult: 1 };
        if (d[0]===d[2]) return { dice:d, name: `${d[1]}の目`, rank: 2, score: d[1], mult: 1 };
    }
    return { dice: [0,0,0], name: "目なし", rank: 1, score: 0, mult: 1 };
};

const generateDeck = () => {
    const suits = ['♠', '♥', '♣', '♦'], ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let suit of suits) for (let rank of ranks) deck.push({ suit, rank, value: (rank === 'A') ? 1 : (['J', 'Q', 'K'].includes(rank) ? 10 : parseInt(rank)) });
    for(let i = deck.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [deck[i], deck[r]] = [deck[r], deck[i]]; }
    return deck;
};

const calculateBJScore = (hand) => {
    let score = 0, aces = 0;
    for (let c of hand) { if (c.rank === 'A') { aces++; score += 11; } else { score += c.value; } }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
};

const getPokerRank = (hand) => {
    const rc = {}, sc = {}, vals = [];
    hand.forEach(c => { let v = (c.rank === 'A') ? 14 : (['J','Q','K'].includes(c.rank) ? [11,12,13][['J','Q','K'].indexOf(c.rank)] : parseInt(c.rank)); vals.push(v); rc[v] = (rc[v] || 0) + 1; sc[c.suit] = (sc[c.suit] || 0) + 1; });
    vals.sort((a, b) => b - a);
    const isF = Object.keys(sc).length === 1;
    let isS = true;
    for (let i = 0; i < 4; i++) { if (vals[i] - 1 !== vals[i+1]) { isS = false; break; } }
    if (!isS && vals[0] === 14 && vals[1] === 5 && vals[2] === 4 && vals[3] === 3 && vals[4] === 2) { isS = true; vals[0] = 1; vals.sort((a, b) => b - a); }
    const countsArr = Object.entries(rc).map(([k, v]) => ({ v: parseInt(k), c: v })).sort((a, b) => (b.c !== a.c) ? b.c - a.c : b.v - a.v);

    let rank = 0, name = "ノーペア";
    if (isF && isS) { if (vals[0] === 14 && vals[1] === 13) { rank = 9; name = "ロイヤルストレートフラッシュ"; } else { rank = 8; name = "ストレートフラッシュ"; } }
    else if (countsArr[0].c === 4) { rank = 7; name = "フォーカード"; }
    else if (countsArr[0].c === 3 && countsArr[1].c === 2) { rank = 6; name = "フルハウス"; }
    else if (isF) { rank = 5; name = "フラッシュ"; }
    else if (isS) { rank = 4; name = "ストレート"; }
    else if (countsArr[0].c === 3) { rank = 3; name = "スリーカード"; }
    else if (countsArr[0].c === 2 && countsArr[1].c === 2) { rank = 2; name = "ツーペア"; }
    else if (countsArr[0].c === 2) { rank = 1; name = "ワンペア"; }
    return { rank, name, scoreArr: countsArr.map(o => o.v) };
};

const comparePoker = (a, b) => {
    if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
    for (let i = 0; i < a.scoreArr.length; i++) { if (a.scoreArr[i] !== b.scoreArr[i]) return a.scoreArr[i] > b.scoreArr[i] ? 1 : -1; }
    return 0;
};

const getPokerBotKeepIndices = (hand) => {
    let counts = {};
    hand.forEach((c, i) => { let v = c.rank === 'A' ? 14 : (['J','Q','K'].includes(c.rank) ? [11,12,13][['J','Q','K'].indexOf(c.rank)] : parseInt(c.rank)); if(!counts[v]) counts[v] = []; counts[v].push(i); });
    let keep = [], maxV = 0, maxVIdx = 0;
    for (let v in counts) { if (counts[v].length >= 2) keep.push(...counts[v]); if (parseInt(v) > maxV) { maxV = parseInt(v); maxVIdx = counts[v][0]; } }
    if (keep.length === 0) keep.push(maxVIdx); 
    return keep;
};

const getYachtRank = (dice) => {
    let counts = {};
    dice.forEach(d => counts[d] = (counts[d] || 0) + 1);
    const countsArr = Object.entries(counts).map(([k, v]) => ({ v: parseInt(k), c: v })).sort((a, b) => (b.c !== a.c) ? b.c - a.c : b.v - a.v);
    let strStr = [...new Set(dice)].sort((a, b) => a - b).join('');
    
    let rank = 0, name = "役なし";
    if (countsArr[0].c === 5) { rank = 6; name = "ヨット (5カード)"; }
    else if (strStr.includes('12345') || strStr.includes('23456')) { rank = 5; name = "ビッグストレート"; }
    else if (countsArr[0].c === 4) { rank = 4; name = "フォーダイス"; }
    else if (countsArr[0].c === 3 && countsArr[1].c === 2) { rank = 3; name = "フルハウス"; }
    else if (strStr.includes('1234') || strStr.includes('2345') || strStr.includes('3456')) { rank = 2; name = "スモールストレート"; }
    else if (countsArr[0].c === 3) { rank = 1; name = "スリーダイス"; }
    return { rank, name, scoreArr: countsArr.map(o => o.v) };
};

const compareYacht = (a, b) => {
    if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
    for (let i = 0; i < a.scoreArr.length; i++) { if (a.scoreArr[i] !== b.scoreArr[i]) return a.scoreArr[i] > b.scoreArr[i] ? 1 : -1; }
    return 0;
};

const getYachtBotKeepIndices = (dice) => {
    let counts = {};
    dice.forEach((d, i) => { if(!counts[d]) counts[d] = []; counts[d].push(i); });
    let keep = [];
    for (let d in counts) { if (counts[d].length >= 2) keep.push(...counts[d]); }
    if (keep.length === 0) { let maxD = 0, maxI = 0; dice.forEach((d, i) => { if (d > maxD) { maxD = d; maxI = i; }}); keep.push(maxI); }
    return keep;
};

const createDaifugoRoom = async (aid, mainRoomId) => {
    if (!BOT_ACCOUNT_ID) return null;
    const params = new URLSearchParams();
    params.append('name', `[大富豪手札] Player:${aid}`);
    params.append('members_admin_ids', BOT_ACCOUNT_ID);
    params.append('members_member_ids', aid);
    params.append('description', '大富豪の専用手札部屋です。');
    params.append('icon_preset', 'group');
    try { const r = await chatworkClient.post('/rooms', params.toString()); daifugoRooms[r.data.room_id.toString()] = { mainRoomId, aid }; return r.data.room_id.toString(); } catch(e) { return null; }
};

const deleteDaifugoRoom = async (pRoomId) => {
    try { const params = new URLSearchParams(); params.append('action_type', 'delete'); await chatworkClient.delete(`/rooms/${pRoomId}`, { data: params.toString() }); delete daifugoRooms[pRoomId]; } catch(e) {}
};

const createDaifugoDeck = () => {
    const suits = ['♠','♥','♦','♣'], ranks = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
    let d = []; for(let s of suits) for(let r of ranks) d.push(s+r); d.push('JOKER'); return d.sort(()=>Math.random()-0.5);
};

const getDaifugoVal = (cardStr) => {
    if (cardStr === 'JOKER') return 16;
    let r = cardStr.slice(1);
    if (r==='A') return 14; if (r==='2') return 15; if (r==='J') return 11; if (r==='Q') return 12; if (r==='K') return 13;
    return parseInt(r);
};

const parseDaifugoPlay = (playStrs, handStrs, field, isKakumei, isJBack) => {
    for(let c of playStrs) if(!handStrs.includes(c)) return {valid:false, msg:'手札に無いカードです'};
    let vals = playStrs.map(c => getDaifugoVal(c)).sort((a,b)=>a-b);
    let type = playStrs.length === 1 ? 'single' : (vals.every(v => v === vals[0] || v === 16) ? 'pair' : '');
    if(!type) return {valid:false, msg:'単発かペアのみ対応しています'};

    let baseVal = vals.find(v => v !== 16) || 16;
    let rev = isKakumei !== isJBack; 
    
    if (field) {
        if (field.count !== playStrs.length) return {valid:false, msg:'場の枚数と違います'};
        if (field.type !== type) return {valid:false, msg:'場の役と違います'};
        let validVal = rev ? baseVal < field.val : baseVal > field.val;
        if(playStrs.includes('JOKER')) validVal = true;
        if(!validVal) return {valid:false, msg:'場のカードより弱いか同じです'};
    }
    return {valid:true, type, count: playStrs.length, val: baseVal, is8: baseVal === 8, isJ: baseVal === 11, isKaku: playStrs.length >= 4};
};

// --- タイマー＆進行管理 ---
const startGameTimer = (roomId, ms = 60000, isDerby = false) => {
    let game = gameState[roomId]; 
    if (!game) return;
    if (game.timeoutId) clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    if (isDerby) game.remindId = setTimeout(() => { if (gameState[roomId] && gameState[roomId].state === 'BETTING') sendTempMessage(roomId, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は /bet [額] [馬番-馬番] を入力してください。[/info]`); }, ms - 60000);
    game.timeoutId = setTimeout(() => handleGameTimeout(roomId), ms);
};

const handleGameTimeout = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        let isEnoughPlayers = ['bj', 'poker', 'yacht', 'cc', 'sicbo', 'rolet', 'buta', 'daifugo'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
        if (game.type === 'russian') isEnoughPlayers = (game.players.length === 2);

        if (isEnoughPlayers) {
            game.state = 'BETTING';
            if (game.type === 'derby') {
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]/bet [額] [馬1]-[馬2] (例: /bet 100 1-2)\n(※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else if (game.type === 'russian') {
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\nどちらかが /bet [額] を入力してください。\n(※相手の全財産の半分未満である必要があります)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'sicbo') {
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n/bet [額] dai か /bet [額] shou か /bet [額] any\n[hr](※制限1分。 /bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'rolet') {
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n/bet [額] [予想] (red/black/even/odd/high/low/数字)\n[hr](※制限1分。 /bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else {
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n/bet [額] でベットしてください。\n[hr](※制限1分。 /bet life や /bet max も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が規定人数を満たさなかったため中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else if (game.state === 'BETTING') {
        let kickedAids = [], activePlayers = [];
        for (let player of game.players) { if (player.bet === 0 && !player.isLifeBet) kickedAids.push(player.aid); else activePlayers.push(player); }
        game.players = activePlayers;
        
        if (kickedAids.length > 0) await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、未ベットのプレイヤーを退出させました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        
        let isEnoughPlayers = ['bj', 'poker', 'yacht', 'cc', 'sicbo', 'rolet', 'buta', 'daifugo'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
        if (game.type === 'russian') isEnoughPlayers = (game.players.length === 2);

        if (!isEnoughPlayers) {
            for (let player of game.players) {
                if (player.bet > 0) { if (player.isLifeBet) await addMoneyWithRepay(player.aid, player.lifeBetBaseAmount); else await addMoneyWithRepay(player.aid, player.bet); }
            }
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]残りの参加者が規定人数未満になったため中止し、全額返金しました。[/info]`);
            gameState[roomId] = null;
        } else await checkGameProgress(roomId);
    } else if (game.state === 'ACTION') {
        if (['bj', 'poker', 'yacht', 'buta', 'daifugo'].includes(game.type)) {
            let player = game.players[game.turnIndex];
            if (player && player.status === 'playing') {
                if (game.type === 'daifugo') {
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は強制パスしました。[/info]`);
                    game.daifugo.passCount++; await checkDaifugoNextTurn(roomId);
                } else {
                    player.status = 'stand';
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は自動スタンドしました。[/info]`);
                    game.turnIndex++;
                    if (game.type === 'poker') await proceedNextPokerTurn(roomId);
                    else if (game.type === 'yacht') await proceedNextYachtTurn(roomId);
                    else if (game.type === 'buta') await proceedNextButaTurn(roomId);
                    else await proceedNextBJTurn(roomId);
                }
            }
        } else if (game.type === 'russian') {
            let player = game.players[game.turnIndex];
            if (player && player.status === 'playing') {
                await sendTempMessage(roomId, `[info]⏳ タイムアウト (逃亡)\n[piconname:${player.aid}] が逃げ出しました。永久追放処分とします。[/info]`);
                await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', player.aid);
                await supabase.from('blacklist').insert({ account_id: player.aid });
                await updateRoomMembers(roomId, [player.aid], 'readonly');
                
                let winner = game.players.find(p => p.aid !== player.aid);
                let winAmt = winner.bet * 2;
                await addMoneyWithRepay(winner.aid, winAmt);
                await updatePlayerStats(winner.aid, winner.bet, winAmt, 'win');
                await updateWinStreak(winner.aid, 'win', roomId);
                
                await sendMessage(roomId, `[info][title]🔫 ロシアンルーレット 不戦勝[/title]勝者: [piconname:${winner.aid}] (+${formatNumber(winAmt)})\n相手が逃げ出したため、賭け金を総取りしました！[/info]`);
                gameState[roomId] = null;
            }
        } else {
            let kickedAids = [], activePlayers = [];
            for (let player of game.players) {
                let isKicked = false;
                if (game.type === 'chouhan' && !player.choice) isKicked = true;
                if (game.type === 'cc' && !player.res) isKicked = true;
                if (isKicked) {
                    kickedAids.push(player.aid);
                    await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', player.aid);
                    if (player.isLifeBet) { await supabase.from('blacklist').insert({ account_id: player.aid }); await updateRoomMembers(roomId, [player.aid], 'readonly'); }
                } else activePlayers.push(player);
            }
            game.players = activePlayers;
            
            if (kickedAids.length > 0) await sendTempMessage(roomId, `[info][title]⏳ タイムアウト (没収)[/title]時間切れのため未操作のプレイヤーを退出させ、賭け金を没収しました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
            
            let isEnoughPlayers = ['cc'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
            if (!isEnoughPlayers) {
                await sendTempMessage(roomId, `[info][title]⚠️ ゲーム終了[/title]参加者がいなくなったため、ゲームを終了します。[/info]`);
                gameState[roomId] = null;
            } else {
                if (game.type === 'chouhan') await proceedBotChouhan(roomId);
                else if (game.type === 'cc') await proceedBotChinchiroTurn(roomId);
            }
        }
    }
};

const checkGameProgress = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.state === 'IDLE') return;
    
    if (game.state === 'BETTING' && game.players.every(p => (p.bet > 0 || p.isLifeBet) && !p.pendingLifeBet)) {
        if (game.type === 'derby') {
            clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
            await proceedBotDerby(roomId);
        } else if (game.type === 'sicbo') {
            clearTimeout(game.timeoutId); await proceedBotSicbo(roomId);
        } else if (game.type === 'rolet') {
            clearTimeout(game.timeoutId); await proceedBotRoulette(roomId);
        } else if (game.type === 'russian') {
            game.state = 'ACTION';
            game.bulletPos = Math.floor(Math.random() * 6);
            game.currentChamber = 0;
            game.turnIndex = Math.floor(Math.random() * 2); 
            game.players.forEach(p => p.status = 'playing');
            
            let frames = [];
            for(let i=0; i<3; i++) { frames.push(`[info]🔫 カラカラカラ...[/info]`); frames.push(`[info]🔫 カチャッ！\n準備完了。[/info]`); }
            await playAnimation(roomId, `[info]🔫 リボルバーのシリンダーを回しています...[/info]`, (i) => frames[i], 6, 600);
            
            let firstPl = game.players[game.turnIndex];
            await sendTempMessage(roomId, `[info][title]🔫 ロシアンルーレット 開始[/title]弾は6発中1発。\n先攻は [piconname:${firstPl.aid}] です！\n/shoot と発言して引き金を引いてください。[/info]`);
            startGameTimer(roomId, 60000);
        } else if (game.type === 'bj') {
            game.state = 'ACTION';
            game.deck = generateDeck(); game.dealerHand = [game.deck.pop(), game.deck.pop()];
            let msg = `[info][title]🃏 ブラックジャック 開始[/title]全員ベット完了！カードを配ります。\n\n【 ディーラー 】\n🎴 ${game.dealerHand[0].suit}${game.dealerHand[0].rank} / [裏]\n[hr]【 プレイヤー 】\n`;
            for (let p of game.players) {
                p.hand = [game.deck.pop(), game.deck.pop()];
                let pScore = calculateBJScore(p.hand);
                msg += `[piconname:${p.aid}]: ${p.hand.map(c => c.suit + c.rank).join(' ')} (スコア: ${pScore})`;
                if (pScore === 21) { p.status = 'bj'; msg += ` 🎉 ブラックジャック！\n`; } 
                else { p.status = 'playing'; msg += `\n`; }
            }
            await sendTempMessage(roomId, msg + `[/info]`, 120000);
            game.turnIndex = 0; await proceedNextBJTurn(roomId);
        } else if (game.type === 'poker') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            for (let p of game.players) { p.hand = []; for(let i=0; i<5; i++) p.hand.push(game.deck.pop()); p.status = 'playing'; }
            await sendTempMessage(roomId, `[info][title]🃏 ポーカー 開始[/title]全員ベット完了！5枚ずつカードを配ります。\n\n[/info]`, 120000);
            game.turnIndex = 0; await proceedNextPokerTurn(roomId);
        } else if (game.type === 'yacht') {
            game.state = 'ACTION';
            for (let p of game.players) { p.dice = []; p.status = 'playing'; p.rolls = 0; }
            await sendTempMessage(roomId, `[info][title]🎲 ヨット 開始[/title]全員のベットが完了しました！\n順番にサイコロを振ります。[/info]`, 120000);
            game.turnIndex = 0; await proceedNextYachtTurn(roomId);
        } else if (game.type === 'buta') {
            game.state = 'ACTION'; game.deck = generateDeck(); game.dealerHand = [game.deck.pop()];
            let msg = `[info][title]🐷 豚のしっぽ 開始[/title]全員ベット完了！最初のカードを配ります。\n\n【 ディーラー 】\n🎴 ${game.dealerHand[0].suit}${game.dealerHand[0].rank}\n[hr]【 プレイヤー 】\n`;
            for (let p of game.players) { p.hand = [game.deck.pop()]; p.status = 'playing'; msg += `[piconname:${p.aid}]: ${p.hand.map(c => c.suit + c.rank).join(' ')} (枚数: 1)\n`; }
            await sendTempMessage(roomId, msg + `[/info]`, 120000);
            game.turnIndex = 0; await proceedNextButaTurn(roomId);
        } else if (game.type === 'daifugo') {
            game.state = 'ACTION'; game.deck = createDaifugoDeck();
            game.players.push({ aid: 'bot', status: 'playing', hand: [] });
            let tP = game.players.length;
            for(let i=0; i<53; i++) game.players[i % tP].hand.push(game.deck[i]);
            let msg = `[info][title]👑 大富豪 開始[/title]全員ベット完了！\n各プレイヤーの手札専用部屋を作成しました。\n\n`;
            for (let p of game.players) {
                if (p.aid !== 'bot') {
                    p.pRoomId = await createDaifugoRoom(p.aid, roomId);
                    msg += `[piconname:${p.aid}] 様の部屋: https://www.chatwork.com/#!rid${p.pRoomId}\n`;
                    if (p.pRoomId) sendMessage(p.pRoomId, `[info][title]🃏 あなたの手札[/title]${p.hand.map(c=>`[ ${c} ]`).join(' ')}\n\n出せるカードを /play S3 や /play H4 D4 のように指定するか、 /pass してください。[/info]`);
                }
            }
            await sendTempMessage(roomId, msg + `[hr]順番に進行します。手札部屋からコマンドを送信してください。\n[/info]`, 120000);
            game.daifugo = { field: null, isKakumei: false, isJBack: false, passCount: 0, rankings: [] };
            game.turnIndex = Math.floor(Math.random() * tP);
            await checkDaifugoNextTurn(roomId);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 /chou (丁) または /han (半) と発言してください。" : "各プレイヤーは /roll でサイコロを振ってください。";
            await sendTempMessage(roomId, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(roomId, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.every(p => p.choice)) await proceedBotChouhan(roomId);
        if (game.type === 'cc' && game.players.every(p => p.res)) await proceedBotChinchiroTurn(roomId);
    }
};

// --- 大富豪 ---
const checkDaifugoNextTurn = async (roomId) => {
    let g = gameState[roomId];
    if (!g || g.type !== 'daifugo') return;
    let activeCount = g.players.filter(p => p.status === 'playing').length;
    if (activeCount <= 1) return await resolveDaifugo(roomId);
    if (g.daifugo.passCount >= activeCount - 1) { g.daifugo.field = null; g.daifugo.isJBack = false; g.daifugo.passCount = 0; await sendMessage(roomId, `[info]🔄 全員がパスしました。場が流れます。[/info]`); }
    let p = g.players[g.turnIndex];
    while (p.status !== 'playing') { g.turnIndex = (g.turnIndex + 1) % g.players.length; p = g.players[g.turnIndex]; }
    let fStr = g.daifugo.field ? `【 ${g.daifugo.field.count} 枚出し (強さ: ${g.daifugo.field.val}) 】` : "【 自由 (空) 】";
    let stateStr = (g.daifugo.isKakumei ? "🔥 革命中！ " : "") + (g.daifugo.isJBack ? "💫 イレブンバック中！" : "");
    await sendTempMessage(roomId, `[info]👑 ターン進行: ${p.aid==='bot'?'[ディーラー]':`[piconname:${p.aid}]`} の番です。\n現在の場: ${fStr}\n${stateStr}[/info]`);
    
    if (p.aid === 'bot') setTimeout(() => proceedBotDaifugoTurn(roomId), 2000);
    else {
        if (p.pRoomId) sendMessage(p.pRoomId, `[info]📣 あなたのターンです！\n場: ${fStr}\n状態: ${stateStr}\n手札: ${p.hand.map(c=>`[ ${c} ]`).join(' ')}\n\n/play または /pass を入力してください。[/info]`);
        startGameTimer(roomId, 60000); 
    }
};

const handleDaifugoAction = async (mainRoomId, aid, body) => {
    let g = gameState[mainRoomId];
    if (!g || g.type !== 'daifugo' || g.state !== 'ACTION') return;
    let p = g.players[g.turnIndex];
    if (!p || p.aid !== aid || p.status !== 'playing') return;
    if (body.startsWith('/pass')) {
        g.daifugo.passCount++; await sendMessage(mainRoomId, `[info][piconname:${aid}] は パス しました。[/info]`);
        g.turnIndex = (g.turnIndex + 1) % g.players.length; await checkDaifugoNextTurn(mainRoomId);
        return;
    }
    if (body.startsWith('/play ')) {
        let playStrs = body.replace('/play ', '').trim().split(/\s+/);
        let res = parseDaifugoPlay(playStrs, p.hand, g.daifugo.field, g.daifugo.isKakumei, g.daifugo.isJBack);
        if (!res.valid) return sendMessage(p.pRoomId, `[info]⚠️ 出せません: ${res.msg}[/info]`);
        p.hand = p.hand.filter(c => !playStrs.includes(c)); g.daifugo.field = res; g.daifugo.passCount = 0;
        await sendMessage(mainRoomId, `[info][piconname:${aid}] が 【 ${playStrs.join(' ')} 】 を出しました！ (残り ${p.hand.length}枚)[/info]`);
        if (res.isKaku) { g.daifugo.isKakumei = !g.daifugo.isKakumei; await sendMessage(mainRoomId, `[info]🔥 革命発生！！！[/info]`); }
        if (res.isJ) { g.daifugo.isJBack = true; await sendMessage(mainRoomId, `[info]💫 イレブンバック発生！[/info]`); }
        if (p.hand.length === 0) { p.status = 'won'; g.daifugo.rankings.push(p); await sendMessage(mainRoomId, `[info]🎉 [piconname:${aid}] が上がりました！[/info]`); }
        if (res.is8) { await sendMessage(mainRoomId, `[info]✂️ 8切り！ ターン継続！[/info]`); g.daifugo.field = null; g.daifugo.isJBack = false; await checkDaifugoNextTurn(mainRoomId); return; }
        g.turnIndex = (g.turnIndex + 1) % g.players.length; await checkDaifugoNextTurn(mainRoomId);
    }
};

const proceedBotDaifugoTurn = async (roomId) => {
    let g = gameState[roomId];
    if (!g || g.type !== 'daifugo') return;
    let p = g.players[g.turnIndex];
    let rev = g.daifugo.isKakumei !== g.daifugo.isJBack;
    p.hand.sort((a,b) => rev ? getDaifugoVal(b) - getDaifugoVal(a) : getDaifugoVal(a) - getDaifugoVal(b)); 
    let playStrs = [];
    if (!g.daifugo.field) playStrs.push(p.hand[0]);
    else {
        let f = g.daifugo.field, cCounts = {};
        p.hand.forEach(c => { let v = getDaifugoVal(c); cCounts[v] = (cCounts[v]||[]); cCounts[v].push(c); });
        for (let v in cCounts) {
            let numV = parseInt(v); let canBeat = rev ? numV < f.val : numV > f.val; if (numV === 16) canBeat = true; 
            if (cCounts[v].length >= f.count && canBeat) { playStrs = cCounts[v].slice(0, f.count); break; }
        }
    }
    if (playStrs.length > 0) {
        let res = parseDaifugoPlay(playStrs, p.hand, g.daifugo.field, g.daifugo.isKakumei, g.daifugo.isJBack);
        p.hand = p.hand.filter(c => !playStrs.includes(c)); g.daifugo.field = res; g.daifugo.passCount = 0;
        await sendMessage(roomId, `[info]🤖 ディーラーが 【 ${playStrs.join(' ')} 】 を出しました！ (残り ${p.hand.length}枚)[/info]`);
        if (res.isKaku) { g.daifugo.isKakumei = !g.daifugo.isKakumei; await sendMessage(roomId, `[info]🔥 革命発生！！！[/info]`); }
        if (res.isJ) { g.daifugo.isJBack = true; await sendMessage(roomId, `[info]💫 イレブンバック発生！[/info]`); }
        if (p.hand.length === 0) { p.status = 'won'; g.daifugo.rankings.push(p); await sendMessage(roomId, `[info]🎉 ディーラーが上がりました！[/info]`); }
        if (res.is8) { await sendMessage(roomId, `[info]✂️ 8切り！ ディーラーのターンが継続します。[/info]`); g.daifugo.field = null; g.daifugo.isJBack = false; setTimeout(() => checkDaifugoNextTurn(roomId), 1500); return; }
    } else { g.daifugo.passCount++; await sendMessage(roomId, `[info]🤖 ディーラーは パス しました。[/info]`); }
    g.turnIndex = (g.turnIndex + 1) % g.players.length; await checkDaifugoNextTurn(roomId);
};

// --- 各ゲーム アニメーション＆進行処理 ---
const proceedNextBJTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'bj') return;
    while (game.turnIndex < game.players.length) {
        let p = game.players[game.turnIndex];
        if (p.status !== 'playing') { game.turnIndex++; continue; }
        let score = calculateBJScore(p.hand);
        await sendTempMessage(roomId, `[info][title]🃏 ターン進行[/title][piconname:${p.aid}] さんの番です！\n手札: ${p.hand.map(c=>c.suit+c.rank).join(' ')} (スコア: ${score})\n\n/hit (引く) または /stand (引かない) を入力してください。\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); return;
    }
    await proceedBotBJTurn(roomId);
};

const proceedBotBJTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    let dHand = game.dealerHand, dScore = calculateBJScore(dHand);
    await sendMessage(roomId, `[info][ディーラー] のターンです。\n伏せカードをめくります...[/info]`);
    await sleep(2000);
    while (dScore < 17) {
        await sendMessage(roomId, `[info][ディーラー] 手札: ${dHand.map(c=>c.suit+c.rank).join(' ')} (スコア: ${dScore})[/info]`);
        await sleep(1500); await sendMessage(roomId, `/hit`); await sleep(1000);
        let c = game.deck.pop(); dHand.push(c); dScore = calculateBJScore(dHand);
        await sendMessage(roomId, `[info]🃏 [ディーラー] 『 ${c.suit}${c.rank} 』 を引きました。[/info]`);
        await sleep(1500);
    }
    let hStr = dHand.map(c=>c.suit+c.rank).join(' ');
    if (dScore > 21) await sendMessage(roomId, `[info][ディーラー] 手札: ${hStr} (スコア: ${dScore})\n💥 ディーラーがバーストしました！[/info]`);
    else { await sendMessage(roomId, `[info][ディーラー] 手札: ${hStr} (スコア: ${dScore})[/info]`); await sleep(1500); await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`); }
    await sleep(2000); await resolveBJ(roomId);
};

const proceedNextPokerTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'poker') return;
    while (game.turnIndex < game.players.length) {
        let p = game.players[game.turnIndex];
        if (p.status !== 'playing') { game.turnIndex++; continue; }
        let ev = getPokerRank(p.hand);
        await sendTempMessage(roomId, `[info][title]🃏 ポーカー ターン進行[/title][piconname:${p.aid}] さんの番です！\n手札:\n${p.hand.map((c,i)=>`[${i+1}] ${c.suit}${c.rank}`).join('   ')}\n(現状の役: ${ev.name})\n\n交換するカードの番号を指定してください。交換しない場合は /stand\n例: /change 1 3 5\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); return;
    }
    await proceedBotPokerTurn(roomId);
};

const proceedBotPokerTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    game.botHand = []; for(let i=0; i<5; i++) game.botHand.push(game.deck.pop());
    await sendMessage(roomId, `[info][ディーラー] のターンです。\n手札を確認中...[/info]`);
    await sleep(2500);
    let keepIndices = getPokerBotKeepIndices(game.botHand);
    let changeIndices = [0,1,2,3,4].filter(i => !keepIndices.includes(i));
    if (changeIndices.length === 0) {
        await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    } else {
        await sendMessage(roomId, `/change ${changeIndices.map(i=>i+1).join(' ')}`); await sleep(1500);
        let newHand = [];
        for (let i=0; i<5; i++) { if (keepIndices.includes(i)) newHand[i] = game.botHand[i]; else newHand[i] = game.deck.pop(); }
        game.botHand = newHand;
        await sendMessage(roomId, `[info]🃏 [ディーラー] 新しいカードを引きました。[/info]`);
        await sleep(1500); await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    }
    await sleep(2000); await resolvePoker(roomId);
};

const proceedNextYachtTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'yacht') return;
    while (game.turnIndex < game.players.length) {
        let p = game.players[game.turnIndex];
        if (p.status !== 'playing') { game.turnIndex++; continue; }
        if (p.rolls === 0) await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン開始[/title][piconname:${p.aid}] さんの番です！\n/roll を入力して最初のサイコロを振ってください。\n(制限1分)[/info]`);
        else {
            let ev = getYachtRank(p.dice);
            await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン継続 ( ${p.rolls}/3 回目 )[/title][piconname:${p.aid}]\nサイコロ:\n${p.dice.map((d,i)=>`[${i+1}] 🎲${d}`).join('   ')}\n(現状の役: ${ev.name})\n\n/change [番号] または /stand\n例: /change 1 3 5\n(制限1分)[/info]`);
        }
        startGameTimer(roomId, 60000); return;
    }
    await proceedBotYachtTurn(roomId);
};

const proceedBotYachtTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`);
    await sleep(1500); await sendMessage(roomId, `/roll`); await sleep(1000);
    game.botDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
    await playAnimation(roomId, `[info]🎲 [ディーラー] サイコロを振っています...[/info]`, (i) => {
        return `[info]🎲 [ディーラー] サイコロを振っています...\n[ ${Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1).map(d=>`🎲${d}`).join(' ')} ][/info]`;
    }, 8, 400, `[info]🎲 [ディーラー] サイコロを振りました。\n[ ${game.botDice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
    await sleep(2000);
    
    for (let roll = 2; roll <= 3; roll++) {
        let keepIndices = getYachtBotKeepIndices(game.botDice);
        let changeIndices = [0,1,2,3,4].filter(i => !keepIndices.includes(i));
        if (changeIndices.length === 0) {
            await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`); break;
        } else {
            await sendMessage(roomId, `/change ${changeIndices.map(i=>i+1).join(' ')}`); await sleep(1500);
            changeIndices.forEach(idx => game.botDice[idx] = Math.floor(Math.random() * 6) + 1);
            await playAnimation(roomId, `[info]🎲 [ディーラー] サイコロを振り直しています...[/info]`, (i) => {
                let tempD = [...game.botDice]; changeIndices.forEach(idx => tempD[idx] = Math.floor(Math.random()*6)+1);
                return `[info]🎲 [ディーラー] サイコロを振り直しています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`;
            }, 8, 400, `[info]🎲 [ディーラー] サイコロを振り直しました。(${roll}回目)\n[ ${game.botDice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
            await sleep(2000);
            if (roll === 3) { await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`); }
        }
    }
    await sleep(2000); await resolveYacht(roomId);
};

const proceedNextButaTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'buta') return;
    while (game.turnIndex < game.players.length) {
        let p = game.players[game.turnIndex];
        if (p.status !== 'playing') { game.turnIndex++; continue; }
        await sendTempMessage(roomId, `[info][title]🐷 ターン進行[/title][piconname:${p.aid}] さんの番です！\n場: ${p.hand.map(c=>c.suit+c.rank).join(' ')} (枚数: ${p.hand.length})\n\n/draw (引く) または /stand (引かない)\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); return;
    }
    await proceedBotButaTurn(roomId);
};

const proceedBotButaTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    let targetScore = Math.max(2, ...game.players.map(p => p.status==='bust'?0:p.hand.length));
    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`); await sleep(2000);
    while (game.dealerHand.length < targetScore) {
        await sendMessage(roomId, `[info][ディーラー] 場: ${game.dealerHand.map(c=>c.suit+c.rank).join(' ')} (枚数: ${game.dealerHand.length})[/info]`);
        await sleep(1500); await sendMessage(roomId, `/draw`); await sleep(1000);
        let c = game.deck.pop(), prevCard = game.dealerHand[game.dealerHand.length - 1];
        game.dealerHand.push(c);
        await sendMessage(roomId, `[info]🃏 [ディーラー] 『 ${c.suit}${c.rank} 』 を引きました。[/info]`);
        await sleep(1500);
        if (c.suit === prevCard.suit) break;
    }
    let isBust = game.dealerHand.length > 1 && game.dealerHand[game.dealerHand.length - 1].suit === game.dealerHand[game.dealerHand.length - 2].suit;
    if (isBust) await sendMessage(roomId, `[info][ディーラー] 場: ${game.dealerHand.map(c=>c.suit+c.rank).join(' ')}\n💥 ディーラーがドボンしました！[/info]`);
    else {
        await sendMessage(roomId, `[info][ディーラー] 場: ${game.dealerHand.map(c=>c.suit+c.rank).join(' ')} (枚数: ${game.dealerHand.length})[/info]`);
        await sleep(1500); await sendMessage(roomId, `/stand`); await sleep(1000); await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    }
    await sleep(2000); await resolveButa(roomId);
};

const proceedBotChinchiroTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`);
    await sleep(1500); await sendMessage(roomId, `/roll`); await sleep(1000);
    game.botRoll = generateChinchiroRoll();
    await playAnimation(roomId, `[info]🎲 [ディーラー] サイコロを振っています...[/info]`, (i) => {
        let tempD = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
        return `[info]🎲 [ディーラー] サイコロを振っています...\n[ ${tempD.join(', ')} ][/info]`;
    }, 8, 400, `[info]🎲 [ディーラー] の出目: [ ${game.botRoll.dice.join(', ')} ] ➡ 『 ${game.botRoll.name} 』[/info]`);
    await sleep(2000); await resolveChinchiro(roomId);
};

const proceedBotChouhan = async (roomId) => {
    await sendMessage(roomId, `/roll`); await sleep(1000);
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1;
    await playAnimation(roomId, `[info]🎲 [ディーラー] 壺を振っています... [ ? ] [ ? ][/info]`, (i) => {
        return `[info]🎲 [ディーラー] 壺を振っています...\nｶﾗｶﾗ... [ ${Math.floor(Math.random()*6)+1} ] [ ${Math.floor(Math.random()*6)+1} ][/info]`;
    }, 8, 400, `[info]🎲 [ディーラー] 壺を開けました。\n[ ${d1} ] [ ${d2} ][/info]`);
    await sleep(1000);
    
    let game = gameState[roomId]; if (!game) return;
    clearTimeout(game.timeoutId);
    let sum = d1 + d2;
    let result = (sum % 2 === 0) ? 'chou' : 'han';
    let msg = `[info][title]🎲 丁半 最終結果[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let player of game.players) {
        let isWin = player.choice === result;
        let resTxt = "";
        if (player.isLifeBet) {
            resTxt = await processLifeBetResult(player, isWin, false, roomId);
        } else {
            let winAmtForStats = 0, resType = 'lose';
            if (isWin) { 
                let winAmt = player.bet * 2; await addMoneyWithRepay(player.aid, winAmt); winAmtForStats = winAmt; resType = 'win';
                resTxt = `(cracker) 的中！ (+${formatNumber(winAmt)})`; 
            } else resTxt = `💀 はずれ (没収)`; 
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId); else await updateWinStreak(player.aid, 'lose', roomId);
        msg += `[piconname:${player.aid}]: 予想[${player.choice === 'chou' ? '丁' : '半'}] ➡ ${resTxt}\n`; 
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const proceedBotSicbo = async (roomId) => {
    await sendMessage(roomId, `/roll`); await sleep(1000);
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, d3 = Math.floor(Math.random() * 6) + 1;
    await playAnimation(roomId, `[info]🎲 [ディーラー] ダイスマシン回転中... [ ? ] [ ? ] [ ? ][/info]`, (i) => {
        return `[info]🎲 [ディーラー] ダイスマシン回転中...\nｶﾗｶﾗｶﾗ... [ ${Math.floor(Math.random()*6)+1} ] [ ${Math.floor(Math.random()*6)+1} ] [ ${Math.floor(Math.random()*6)+1} ][/info]`;
    }, 8, 400, `[info]🎲 [ディーラー] ダイス確定:\n[ ${d1} ] [ ${d2} ] [ ${d3} ][/info]`);
    await sleep(1000);
    
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId);
    let sum = d1 + d2 + d3, isTriple = d1 === d2 && d2 === d3;
    let resultType = isTriple ? "any" : (sum >= 11 && sum <= 17 ? "dai" : "shou");
    let resultName = isTriple ? "ゾロ目" : (resultType === "dai" ? "大" : "小");
    
    let msg = `[info][title]🎲 シックボー(大小) 最終結果[/title]出目合計: ${sum}\n➡ 『 ${resultName} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let player of game.players) {
        let isWin = false, mult = 0;
        if (player.choice === 'any' && isTriple) { isWin = true; mult = 15; }
        else if ((player.choice === 'dai' || player.choice === 'shou') && player.choice === resultType && !isTriple) { isWin = true; mult = 1.8; }
        let choiceName = player.choice === 'any' ? "ゾロ目" : (player.choice === 'dai' ? "大" : "小");
        let resTxt = "";
        if (player.isLifeBet) {
            resTxt = await processLifeBetResult(player, isWin, false, roomId, mult);
        } else {
            let winAmtForStats = 0, resType = 'lose';
            if (isWin) {
                let winAmt = Math.floor(player.bet * mult); await addMoneyWithRepay(player.aid, winAmt); winAmtForStats = winAmt; resType = 'win';
                resTxt = `(cracker) 的中！ (${mult}倍) (+${formatNumber(winAmt)})`;
            } else resTxt = `💀 はずれ (没収)`;
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId); else await updateWinStreak(player.aid, 'lose', roomId);
        msg += `[piconname:${player.aid}]: 予想[${choiceName}] ➡ ${resTxt}\n`;
    }
    await sendMessage(roomId, msg + "[/info]"); gameState[roomId] = null; 
};

const proceedBotRoulette = async (roomId) => {
    await sendMessage(roomId, `/roll`); await sleep(1000);
    let resultNum = Math.floor(Math.random() * 37);
    await playAnimation(roomId, `[info]🎡 [ディーラー] ルーレットを回しています... [ ?? ][/info]`, (i) => {
        let tempN = Math.floor(Math.random()*37); return `[info]🎡 [ディーラー] ルーレットを回しています...\nｶﾁｶﾁｶﾁ... [ ${tempN} ] (${getRouletteColorStr(tempN)})[/info]`;
    }, 12, 400, `[info]🎡 ルーレット確定: [ ${resultNum} ] (${getRouletteColorStr(resultNum)})[/info]`);
    await sleep(2000);
    
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId);
    let msg = `[info][title]🎡 ルーレット 最終結果[/title]🎯 当たり番号: 【 ${resultNum} 】 (${getRouletteColorStr(resultNum)})\n[hr]【 プレイヤー結果 】\n`;
    for (let player of game.players) {
        let isWin = isRouletteWin(player.choice, resultNum), resTxt = "";
        if (player.isLifeBet) {
            resTxt = await processLifeBetResult(player, isWin, false, roomId, getRouletteMult(player.choice));
        } else {
            let winAmtForStats = 0, resType = 'lose';
            if (isWin) { 
                let mult = getRouletteMult(player.choice); let winAmt = player.bet * mult;
                await addMoneyWithRepay(player.aid, winAmt); winAmtForStats = winAmt; resType = 'win';
                resTxt = `(cracker) 的中！ (${mult}倍) (+${formatNumber(winAmt)})`; 
            } else resTxt = `💀 はずれ (没収)`; 
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId); else await updateWinStreak(player.aid, 'lose', roomId);
        msg += `[piconname:${player.aid}]: 予想[${player.choice}] ➡ ${resTxt}\n`; 
    }
    await sendMessage(roomId, msg + "[/info]"); gameState[roomId] = null; 
};

const proceedBotDerby = async (roomId) => {
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
    let stats = game.stats, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
    let r1 = Math.random() * totalW, s1 = 0, first = 1; for (let i=0; i<6; i++) { s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    ws[first-1] = 0; totalW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * totalW, s2 = 0, second = 1; for (let i=0; i<6; i++) { s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`; let odd = game.oddsMap[winCombo];
    
    await playAnimation(roomId, `[info]🐎 各馬、一斉にスタートしました！[/info]`, (i) => {
        let pos = [1,2,3,4,5,6].sort(() => Math.random() - 0.5); return `[info]🐎 レース中盤...\n現在の先頭は【 ${pos[0]} 】番！ 続いて【 ${pos[1]} 】番！ 追い上げる【 ${pos[2]} 】番！[/info]`;
    }, 6, 800, `[info]🐎 先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)[/info]`);
    await sleep(1500);
    
    let msg = `[info][title]🐎 ダービー 最終結果[/title]🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    for (let player of game.players) {
        let isWin = player.choice === winCombo, resTxt = "";
        if (player.isLifeBet) {
            resTxt = await processLifeBetResult(player, isWin, false, roomId, odd);
        } else {
            let winAmtForStats = 0, resType = 'lose';
            if (isWin) { 
                let winAmt = Math.floor(player.bet * odd); await addMoneyWithRepay(player.aid, winAmt); winAmtForStats = winAmt; resType = 'win';
                resTxt = `(cracker) 的中！ (+${formatNumber(winAmt)} コイン)\n`; 
            } else resTxt = `💀 はずれ (没収)\n`; 
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId); else await updateWinStreak(player.aid, 'lose', roomId);
        msg += `[piconname:${player.aid}]: 予想[${player.choice}] ➡ ${resTxt}`; 
    }
    await sendMessage(roomId, msg + "[/info]"); gameState[roomId] = null; 
};

// --- 結果精算部 ---
const resolveRussian = async (roomId) => {
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId);
    let winner = game.players.find(p => p.status !== 'bust');
    let loser = game.players.find(p => p.status === 'bust');
    
    let winAmt = winner.bet * 2; 
    await addMoneyWithRepay(winner.aid, winAmt);
    
    await updatePlayerStats(winner.aid, winner.bet, winAmt, 'win');
    await updatePlayerStats(loser.aid, loser.bet, 0, 'lose');
    await updateWinStreak(winner.aid, 'win', roomId);
    await updateWinStreak(loser.aid, 'lose', roomId);
    
    let msg = `[info][title]🔫 ロシアンルーレット 決着[/title]勝者: [piconname:${winner.aid}]\n(cracker) 相手の賭け金を奪い取った！ (+${formatNumber(winAmt)})\n\n敗者: [piconname:${loser.aid}] 💀[/info]`;
    await sendMessage(roomId, msg);
    gameState[roomId] = null;
};

const resolveDaifugo = async (roomId) => {
    let g = gameState[roomId]; if (!g) return; clearTimeout(g.timeoutId);
    let lastP = g.players.find(x => x.status === 'playing'); if (lastP) g.daifugo.rankings.push(lastP);
    for (let p of g.players) if (p.pRoomId) await deleteDaifugoRoom(p.pRoomId);

    let msg = `[info][title]👑 大富豪 最終結果[/title]`;
    let ranks = ["大富豪", "富豪", "平民", "貧民", "大貧民"], mults = [3.0, 1.5, 0, 0, 0]; 
    for (let i=0; i<g.daifugo.rankings.length; i++) {
        let p = g.daifugo.rankings[i], rName = ranks[i] || "平民", mult = mults[i] || 0, resTxt = "";
        if (p.aid !== 'bot') {
            let isWin = mult > 0;
            if (p.isLifeBet) { resTxt = await processLifeBetResult(p, isWin, false, roomId, mult); } 
            else {
                let winAmtForStats = 0, resType = 'lose';
                if (isWin) {
                    let winAmt = Math.floor(p.bet * mult); await addMoneyWithRepay(p.aid, winAmt); winAmtForStats = winAmt; resType = 'win';
                    resTxt = `(cracker) ${rName}！ (${mult}倍) (+${formatNumber(winAmt)})`;
                } else resTxt = `💀 ${rName}... (没収)`;
                await updatePlayerStats(p.aid, p.bet, winAmtForStats, resType);
            }
            if (isWin) await updateWinStreak(p.aid, 'win', roomId); else await updateWinStreak(p.aid, 'lose', roomId);
            msg += `${i+1}位: [piconname:${p.aid}] ➡ ${resTxt}\n`;
        } else msg += `${i+1}位: 🤖 ディーラー (${rName})\n`;
    }
    await sendMessage(roomId, msg + "[/info]"); gameState[roomId] = null;
};

// Webhook
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id, body = ev.body || "", senderId = ev.account_id.toString(), msgId = ev.message_id;
    const today = getTodayStr(), thisMonth = getThisMonthStr();

    (async () => {
        try {
            if (daifugoRooms[roomId]) {
                const { mainRoomId, aid } = daifugoRooms[roomId];
                if (senderId !== aid && senderId !== BOT_ACCOUNT_ID) return;
                if (body.startsWith('/pass') || body.startsWith('/play ')) handleDaifugoAction(mainRoomId, aid, body.trim());
                return;
            }

            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { await updateRoomMembers(roomId, [senderId], 'readonly'); await chatworkClient.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{}); return; }

            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            if (body.trim() === '/winner-rank' || body.trim() === '/rtp-rank' || body.trim() === '/winrate-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !eI.includes(d.account_id) && (d.plays || 0) >= 10) : [];
                
                let title = "", s = "";
                if (body.trim() === '/winner-rank') {
                    title = "🏆 勝利数ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => (b.wins||0) - (a.wins||0));
                    s = f.slice(0, 10).map((d, i) => { let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); return `${md} ${i+1}位: [piconname:${d.account_id}]\n　🏆 勝利数: ${d.wins||0}回 (勝率: ${d.plays ? ((d.wins||0)/(d.plays)*100).toFixed(1) : 0}%)`; }).join('\n[hr]');
                } else if (body.trim() === '/rtp-rank') {
                    title = "💹 RTP(回収率)ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => ((b.total_bet||0)>0 ? (b.total_return||0)/(b.total_bet) : 0) - ((a.total_bet||0)>0 ? (a.total_return||0)/(a.total_bet) : 0));
                    s = f.slice(0, 10).map((d, i) => { let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); let rtp = (d.total_bet||0)>0 ? ((d.total_return||0)/(d.total_bet)*100).toFixed(1) : 0; return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💹 RTP: ${rtp}% (総獲得: ${formatNumber(d.total_return||0)})`; }).join('\n[hr]');
                } else if (body.trim() === '/winrate-rank') {
                    title = "📈 勝率ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => ((b.plays||0)>0 ? (b.wins||0)/(b.plays) : 0) - ((a.plays||0)>0 ? (a.wins||0)/(a.plays) : 0));
                    s = f.slice(0, 10).map((d, i) => { let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); let wr = (d.plays||0)>0 ? ((d.wins||0)/(d.plays)*100).toFixed(1) : 0; return `${md} ${i+1}位: [piconname:${d.account_id}]\n　📈 勝率: ${wr}% (${d.wins||0}勝 / ${d.plays||0}戦)`; }).join('\n[hr]');
                }
                if (!s) s = "条件を満たすプレイヤーがいません。(10戦以上必要)";
                return sendTempMessage(roomId, `[info][title]${title}[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                }
            }

            let { data: player } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (!player) {
                player = { account_id: senderId, money: 0, debt: 0, bank: 0, last_interest_time: Date.now(), slot_count: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン', daily_give_amount: 0, last_give_date: today, win_streak: 0, life_bet_unlocked: false, kabu_owned: 0, plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0 };
                await supabase.from('players').insert(player);
            } else if (gambleActive && !body.startsWith('/')) {
                let mc = (player.msg_count || 0) + 1, wl = player.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                player.msg_count = mc; player.work_limit = wl;
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
            }

            let now = Date.now(), lastTime = player.last_interest_time ? Number(player.last_interest_time) : now, myDebt = player.debt || 0, myBank = player.bank || 0;
            if (myDebt > 0) {
                let daysPassed = Math.floor((now - lastTime) / 86400000); 
                if (daysPassed > 0) {
                    myDebt = Math.min(Math.floor(myDebt * Math.pow(1.005, daysPassed)), 990000); lastTime = lastTime + (daysPassed * 86400000);
                    player.debt = myDebt; player.last_interest_time = lastTime;
                    await supabase.from('players').update({ debt: myDebt, last_interest_time: lastTime }).eq('account_id', senderId);
                }
            } else if (lastTime !== now) { player.last_interest_time = now; await supabase.from('players').update({ last_interest_time: now }).eq('account_id', senderId); }
            let myMoney = player ? player.money : 0, myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';

            if (/(^|\n)\/status\b/.test(body)) {
                const remSlot = Math.max(0, 5 - player.slot_count);
                const dStr = myDebt > 0 ? `\n💳 借金: -${formatNumber(myDebt)} コイン` : '';
                const bStr = `\n🏦 預金残高: ${formatNumber(myBank)} コイン`;
                const streakStr = `\n🔥 連勝記録: ${player.win_streak || 0} 連勝`;
                const kabuStr = player.kabu_owned > 0 ? `\n📦 保有株: ${player.kabu_owned} 株` : '';
                const netWorth = myMoney + myBank - myDebt + (player.kabu_owned * kabuData.price);
                let wr = player.plays ? ((player.wins / player.plays) * 100).toFixed(1) : 0;
                let rtp = player.total_bet ? ((player.total_return / player.total_bet) * 100).toFixed(1) : 0;
                const statsStr = `\n⚔️ 戦績: ${player.plays||0}戦 / ${player.wins||0}勝 / ${player.loses||0}敗\n📈 勝率: ${wr}% / 💹 RTP: ${rtp}%`;

                return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${formatNumber(myMoney)} コイン${bStr}${kabuStr}${dStr}\n💎 純資産: ${formatNumber(netWorth)} コイン${streakStr}${statsStr}\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${player.work_limit} 回\n⛩️ 今日の運勢: ${player.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
            }

            if (/(^|\n)\/kabu\b/.test(body) && gambleActive) {
                await updateKabuPrice();
                const chartConf = { type: 'line', data: { labels: kabuData.history.map((_, i) => `${kabuData.history.length - i - 1}h前`).reverse(), datasets: [{ label: '株価(Coin)', data: kabuData.history, borderColor: 'green', fill: false }] }, options: { legend: { display: false } } };
                const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConf))}`;
                try {
                    const imageRes = await axios.get(chartUrl, { responseType: 'arraybuffer' });
                    const imageBuffer = Buffer.from(imageRes.data);
                    const formDataBoundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
                    let postData = `--${formDataBoundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n[info][title]📈 株式市場 (1時間ごとに変動)[/title]💰 現在の株価: ${formatNumber(kabuData.price)} コイン\n📉 市場の残り株数: ${9999 - kabuData.totalIssued} / 9999\n📦 あなたの保有数: ${player.kabu_owned || 0} 株[/info]\r\n--${formDataBoundary}\r\nContent-Disposition: form-data; name="file"; filename="kabu_chart.png"\r\nContent-Type: image/png\r\n\r\n`;
                    const payload = Buffer.concat([ Buffer.from(postData, 'utf8'), imageBuffer, Buffer.from(`\r\n--${formDataBoundary}--\r\n`, 'utf8') ]);
                    await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/files`, payload, { headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': `multipart/form-data; boundary=${formDataBoundary}` } });
                } catch(err) { sendMessage(roomId, `[info][title]📈 株式市場[/title]💰 現在の株価: ${formatNumber(kabuData.price)} コイン\n📉 市場の残り株数: ${9999 - kabuData.totalIssued} / 9999\n📦 あなたの保有数: ${player.kabu_owned || 0} 株\n(グラフ取得に失敗しました)[/info]`); }
                return;
            }

            const buyKabuMatch = body.match(/(^|\n)\/buy-kabu\s+([0-9]+)/);
            if (buyKabuMatch && gambleActive) {
                await updateKabuPrice(); let cnt = parseInt(buyKabuMatch[2], 10);
                if (cnt > 0) {
                    if (kabuData.totalIssued + cnt > 9999) return sendTempMessage(roomId, `[info]⚠️ 市場に十分な株が残っていません。(残り: ${9999 - kabuData.totalIssued}株)[/info]`);
                    let cost = kabuData.price * cnt;
                    if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ 所持金が足りません。(必要: ${formatNumber(cost)} コイン)[/info]`);
                    kabuData.totalIssued += cnt; await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                    await supabase.from('players').update({ money: myMoney - cost, kabu_owned: (player.kabu_owned || 0) + cnt }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info]📈 [piconname:${senderId}]\n株を ${cnt} 株購入しました。(-${formatNumber(cost)} コイン)[/info]`);
                }
            }

            const sellKabuMatch = body.match(/(^|\n)\/sell-kabu\s+(all|[0-9]+)/);
            if (sellKabuMatch && gambleActive) {
                await updateKabuPrice(); let cnt = sellKabuMatch[2] === 'all' ? (player.kabu_owned || 0) : parseInt(sellKabuMatch[2], 10);
                if (cnt > 0 && (player.kabu_owned || 0) >= cnt) {
                    let revenue = kabuData.price * cnt; kabuData.totalIssued -= cnt;
                    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                    await supabase.from('players').update({ kabu_owned: player.kabu_owned - cnt }).eq('account_id', senderId);
                    await addMoneyWithRepay(senderId, revenue);
                    return sendTempMessage(roomId, `[info]📉 [piconname:${senderId}]\n株を ${cnt} 株売却しました。(+${formatNumber(revenue)} コイン)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ 指定した数の株を所持していません。[/info]`);
            }

            const helpMatch = body.trim().match(/^\/help\s+([a-zA-Z]+)$/);
            if (helpMatch) {
                let g = helpMatch[1].toLowerCase(), txt = "";
                if (g === 'poker') txt = `[title]🃏 ポーカーのルール[/title]ディーラーと1対1で役の強さを競います。\n配られた5枚のカードを1回だけ交換できます。\n【配当】ディーラーより強ければ 賭け金×2 (利益+100%)。引き分けは返金。\n【役の強さ】ロイヤル > ストフラ > 4カード > フルハウス > フラッシュ > ストレート > 3カード > 2ペア > 1ペア > ノーペア`;
                else if (g === 'yacht') txt = `[title]🎲 ヨットのルール[/title]ディーラーと5つのサイコロの役の強さを競います。\nサイコロは最大2回まで(計3投)振り直せます。\n【配当】ディーラーより強ければ 賭け金×2 (利益+100%)。引き分けは返金。\n【注意】「役なし」で終わった場合は無条件で負け(没収)になります。\n【役の強さ】ヨット(5つ同じ) > ビッグストレート > 4ダイス > フルハウス > スモールストレート > 3ダイス > 役なし`;
                else if (g === 'bj') txt = `[title]🃏 ブラックジャックのルール[/title]カードの合計を「21」に近づけるゲーム。\n21を超えるとバースト(即負け)。\nJ,Q,Kは「10」、Aは「1」か「11」として扱います。\n【配当】勝てば 2倍。最初から21(BJ)なら 2.5倍！引き分けは返金。`;
                else if (g === 'cc') txt = `[title]🎲 チンチロリンのルール[/title]サイコロを3つ振り、親(ディーラー)と出目を競います。\n同じ目が2つ出た時、残りの1つが「出目」になります。\n【配当】役によって 賭け金×役の倍率 を追加で獲得(または没収)します。\nピンゾロ(5倍), 嵐(3倍), シゴロ(2倍), 普通の目(1倍), ヒフミ(-2倍・即負け)。`;
                else if (g === 'derby') txt = `[title]🐎 ダービーのルール[/title]6頭の馬から、1位と2位になる馬の組み合わせ(馬連)を予想します。\nオッズに従って配当が変動します。( /bet 100 1-2 のように馬番を指定 )`;
                else if (g === 'chouhan') txt = `[title]🎲 丁半のルール[/title]2つのサイコロの合計が「丁(偶数)」か「半(奇数)」かを予想します。\n的中すれば賭け金が2倍になります。`;
                else if (g === 'sicbo') txt = `[title]🎲 シックボー(大小)のルール[/title]3つのサイコロを振ります。\n合計が11〜17なら「dai(大)」、4〜10なら「shou(小)」。ゾロ目なら「any」です。\n【配当】大・小 (1.8倍) / エニートリプル (15倍)`;
                else if (g === 'rolet') txt = `[title]🎡 ルーレットのルール[/title]数字(0〜36)や属性にベットします。\n/bet 100 red (赤), black (黒), even (偶数), odd (奇数), high (19-36), low (1-18)\nまたは /bet 100 5 のように数字を指定できます。\n【配当】属性は 2倍。数字単体は 36倍。`;
                else if (g === 'buta') txt = `[title]🐷 豚のしっぽのルール[/title]ディーラーとチキンレースをします。\n/draw でカードを引き、直前に引いたカードと「同じマーク(スート)」が出たらドボン(即負け)。\n任意のタイミングで /stand で確定できます。\n【配当】ディーラーより引いた枚数が多ければ 賭け金×2。引き分けは返金。`;
                else if (g === 'daifugo') txt = `[title]👑 大富豪のルール[/title]各プレイヤーに個別の「手札部屋」が作られます。\n手札部屋から /play S3 や /play H4 D4 のように出して進行します。\n出せない場合は /pass してください。\n【配当】1位(大富豪): 3倍、2位(富豪): 1.5倍、それ以外は没収。`;
                else if (g === 'russian') txt = `[title]🔫 ロシアンルーレットのルール[/title]【対人専用】相手と命を賭けたチキンレースを行います。\n/bet [額] で賭け金を決めます。(相手の全財産の半分未満)\nシリンダーを回し、交互に /shoot で引き金を引きます。\n生き残った方が賭け金を総取りします！`;
                else txt = `指定されたゲームのルールは見つかりませんでした。`;
                return sendTempMessage(roomId, `[info]${txt}[/info]`, 120000);
            }

            if (/(^|\n)\/help-gya\b/.test(body)) {
                const helpMsg = `[info][title]🎰 カジノ＆ライフ 総合案内 (V51 Ultimate)[/title]
【 🏦 銀行・借金・株式 】
/status : 状態確認(所持金, 預金, 借金, 純資産, 戦績)
/deposit [金額|max|half] : 所持金を銀行へ預け入れる
/withdraw [金額|max|half] : 銀行から引き出す
/debt [金額] : 借金する (上限99万。1日ごとに0.5%の複利で増殖)
/repay [金額|max|half] : 手動で借金を返済する
/give [金額] : 相手に送金 (税金10%, 1日最大50万まで)
/kabu : 株価推移グラフ
/buy-kabu [個数], /sell-kabu [個数|all] : 株の売買

【 📊 ランキング系 】
/money-rank : 純資産ランキング
/winner-rank : 勝利数ランキング
/rtp-rank : RTP(回収率)ランキング
/winrate-rank : 勝率ランキング

【 💼 職業・スキル 】
/job : 転職と求人
/work : 職業給料 (10分に1回, 1日5回上限)
/catch または /goal : 職業専用能力
/omikuji : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
/slot [掛金|max|half] : スロット (最大ベット 999万)
/buy-lot [連番|バラ] [枚数] : 宝くじ (最大1000枚)

【 🎲 テーブルゲーム 】 (詳しいルールは /help [ゲーム名])
※1回の最大ベット額は 999万。
※ /bet life : 命を賭ける (8連勝した者のみ使用可能。成功で所持金+銀行が8~15倍。失敗で永久出禁)
/chouhan : 丁半
/sicbo : シックボー (/bet [額] [dai/shou/any])
/cc : チンチロリン
/rolet : ルーレット (/bet [額] [red/even/数字など])
/derby : ダービー (/bet [額] [馬番-馬番])
/bj : ブラックジャック (/hit か /stand)
/poker : ポーカー (/change [番号] か /stand)
/yacht : ヨット (/change [番号] か /stand)
/buta : 豚のしっぽ (/draw か /stand)
/daifugo : 大富豪
/russian : ロシアンルーレット (対人専用チキンレース)

【 👑 管理者専用 】
/take [金], /fi-game, /st-gya, /fi-gya, /blacklist 等[/info]`;
                return sendTempMessage(roomId, helpMsg, 120000);
            }

            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let takeMatch = body.match(/(?:^|\n)\/take\s+(.*)/);
                if (takeMatch) {
                    let args = takeMatch[1].trim().split(/\s+/);
                    let targetAid = repliedAid, amtStr = null;
                    if (args.length === 1 && targetAid) amtStr = args[0];
                    else if (args.length >= 2) { targetAid = args[0]; amtStr = args[1]; }
                    if (targetAid && amtStr) {
                        let amt = parseInt(amtStr, 10);
                        if (!isNaN(amt) && amt !== 0) {
                            await addMoneyWithRepay(targetAid, amt);
                            let action = amt > 0 ? "付与しました" : "没収しました";
                            return sendTempMessage(roomId, `[info][title]👑 特別資金操作[/title]管理者が [piconname:${targetAid}] 様へ ${formatNumber(Math.abs(amt))} コインを${action}。[/info]`); 
                        }
                    }
                }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                if (gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                    for (let p of gameState[roomId].players) {
                        if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                    }
                    clearTimeout(gameState[roomId].timeoutId);
                    if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                    gameState[roomId] = null;
                    return sendTempMessage(roomId, `[info][title]⚠️ ゲーム強制終了[/title]管理者によってゲームが強制終了されました。\n(※賭け金は全額返還されました)[/info]`);
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
                    await updateRoomMembers(roomId, [targetAid], 'readonly'); 
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

            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (player && player.omikuji_date === today) return sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeReplyTag(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${player.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
                else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', senderId);
                return sendMessage(roomId, `[info][title]⛩️ おみくじ結果[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            }

            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (/(^|\n)\/job\b/.test(body) && !body.match(/(^|\n)\/job\s+/) && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)\n ▶ /work (100〜500) ※10%でミス0
🏛️ 公務員 (費用: 2000)\n ▶ /work (300〜500)
🚓 警察官 (費用: 3000)\n ▶ /work (300〜700)\n ▶ /catch (30%の確率で犯人逮捕! 800)
⚽ プロスポーツ選手 (費用: 5000)\n ▶ /work (500〜1000)\n ▶ /goal (30%の確率でゴール! 1000)
[hr]※転職コマンド: /job 役職名[/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (player.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (player.last_work_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${formatNumber(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${formatNumber(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${formatNumber(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${formatNumber(e)} コイン稼ぎました！⚽`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                let iC = /(^|\n)\/catch\b/.test(body);
                if (iC && myJob !== '警察官') return sendTempMessage(roomId, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (!iC && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){ e=800; m=`見事犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; } else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){ e=1000; m=`スーパーゴールを決めました！スポンサーから ${e} コイン獲得！🥅✨`; } else m=`シュートは外れてしまいました...🤦‍♂️`; }
                
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}]\n${m}[/info]`);
            }

            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (player.slot_count >= 5) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限(1日5回)に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(10分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? Math.min(myMoney, 9990000) : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                if (bet > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                
                if (bet > 0 && myMoney >= bet) {
                    let updates = { money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() };
                    if (player.life_bet_unlocked) updates.life_bet_unlocked = false;
                    await supabase.from('players').update(updates).eq('account_id', senderId);
                    if (player.life_bet_unlocked) sendTempMessage(roomId, `[info]※通常のベットを行ったため、命賭けの権利は消滅しました。[/info]`);
                    
                    let r = Math.random() * 100, omi = (player.omikuji_date === today) ? player.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } 
                    else if(omi === '大凶') { r += 0.09; }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; if (wA > 0) await addMoneyWithRepay(senderId, wA);
                    await updatePlayerStats(senderId, bet, wA, wA > 0 ? 'win' : 'lose');
                    
                    const syms = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣","🍒","🐉"];
                    let finalSyms = sy.split(" | ");
                    let finalMessage = `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り回数: ${5 - (player.slot_count + 1)}回)[/info]`;
                    
                    await playAnimation(roomId, `[info]🎰 SLOT MACHINE 回転中...\n[ ❓ | ❓ | ❓ ][/info]`, (i) => {
                        let t1 = i < 4 ? syms[Math.floor(Math.random()*9)] : finalSyms[0];
                        let t2 = i < 8 ? syms[Math.floor(Math.random()*9)] : finalSyms[1];
                        let t3 = syms[Math.floor(Math.random()*9)];
                        return `[info]🎰 SLOT MACHINE 回転中...\n[ ${t1} | ${t2} | ${t3} ][/info]`;
                    }, 12, 400, finalMessage);

                } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            if (body.match(/(^|\n)\/(chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian)\b/) && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                let t = body.match(/(^|\n)\/(chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian)\b/)[2];
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                let tN = GAME_NAMES[t] || "ゲーム", ex = `/join`;
                
                if (t === 'derby') {
                    let dO = generateDerby(); gameState[roomId].oddsMap = dO.oddsMap; gameState[roomId].oddsStr = dO.oddsStr; gameState[roomId].st = dO.stats;
                }
                
                if (t === 'russian') sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n対戦相手を待っています... (参加者は ${ex} と入力！)\n[hr]※2人専用のゲームです。[/info]`); 
                else sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※1分経過またはホストが /start で自動進行します。(※一人からでも開始可能です)[/info]`); 
                
                startGameTimer(roomId); return;
            }

            if (body.match(/(^|\n)\/join\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                let g = gameState[roomId];
                if (g.type === 'russian' && g.players.length >= 2) return sendTempMessage(roomId, `[info]⚠️ ロシアンルーレットは2人専用です！[/info]`);
                if (!g.players.find(x => x.aid === senderId)) { 
                    g.players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${g.players.length}人)[/info]`); 
                    if (g.type === 'russian' && g.players.length === 2) { clearTimeout(g.timeoutId); handleGameTimeout(roomId); }
                }
                return;
            }

            if (body.match(/(^|\n)\/start\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                clearTimeout(gameState[roomId].timeoutId); handleGameTimeout(roomId); return;
            }

            if (/(^|\n)\/leave\b/.test(body) && gambleActive && gameState[roomId]) {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; gameState[roomId].players.splice(idx, 1);
                    let pMsg = p.bet > 0 || p.isLifeBet ? " (賭け金没収)" : "";
                    if (p.isLifeBet) {
                        await supabase.from('blacklist').insert({ account_id: p.aid });
                        await updateRoomMembers(roomId, [p.aid], 'readonly'); pMsg = " (命賭けキャンセルペナルティ: 永久追放)";
                    } else if (p.bet > 0) await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', senderId);

                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。${pMsg}[/info]`);
                    if (gameState[roomId].players.length === 0) { 
                        clearTimeout(gameState[roomId].timeoutId); if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|life|[0-9]+)(?:\s+([a-zA-Z0-9-]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let g = gameState[roomId], pl = g.players.find(x => x.aid === senderId);
                if (pl && pl.bet === 0 && !pl.pendingLifeBet) {
                    let betType = bM[2];

                    if (g.type === 'russian') {
                        let b = parseInt(betType, 10);
                        if (isNaN(b) || b <= 0) return sendTempMessage(roomId, `[info]⚠️ /bet [金額] で賭け金を指定してください。[/info]`);
                        if (!g.russianBet) {
                            let op = g.players.find(x => x.aid !== senderId);
                            const { data: opData } = await supabase.from('players').select('money, bank').eq('account_id', op.aid).single();
                            let opNet = opData ? ((opData.money||0) + (opData.bank||0)) : 0;
                            if (b >= opNet / 2) return sendTempMessage(roomId, `[info]⚠️ 賭け金は相手の全財産の半分(${formatNumber(Math.floor(opNet/2))} コイン)未満にしてください！[/info]`);
                            if (myMoney < b) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！[/info]`);
                            g.russianBet = b; pl.bet = b;
                            await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] が ${formatNumber(b)} コインを提示しました。\n相手も /bet ${b} で受けて立ってください。[/info]`);
                        } else {
                            if (b !== g.russianBet) return sendTempMessage(roomId, `[info]⚠️ 提示された ${formatNumber(g.russianBet)} コインをベットしてください。[/info]`);
                            if (myMoney < b) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！[/info]`);
                            pl.bet = b; await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] がベットを受けました！[/info]`);
                            checkGameProgress(roomId);
                        }
                        return;
                    }

                    if (betType === 'life') {
                        if (!player.life_bet_unlocked) return sendTempMessage(roomId, `[info]⚠️ /bet life は8連勝した者のみが使える特権です。[/info]`);
                        if (g.type === 'derby') { let h = bM[3]; if (!h || !g.oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連を正しく指定してください\n例: /bet life 1-2[/info]`); pl.pendingChoice = h; } 
                        else if (g.type === 'sicbo') { let h = bM[3]; if (!h || !['dai','shou','any'].includes(h)) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /bet life dai[/info]`); pl.pendingChoice = h; } 
                        else if (g.type === 'rolet') { let h = bM[3]; if (!h || (!['red','black','even','odd','high','low'].includes(h) && (isNaN(parseInt(h)) || parseInt(h) < 0 || parseInt(h) > 36))) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /bet life red[/info]`); pl.pendingChoice = h; }
                        pl.pendingLifeBet = true;
                        return sendTempMessage(roomId, `[info]⚠️ 【命賭けの確認】\nこれに失敗すると永久に出禁になりますが、成功すると持ち金(銀行含む)が8〜15倍になります。\n本当によろしいですか？\nよろしければ yes 、やめる場合は no と発言してください。[/info]`);
                    } else {
                        let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                        if (b > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                        if (b > 0 && myMoney >= b) {
                            if (g.type === 'derby') { let h = bM[3]; if (!h || !g.oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連を正しく指定してください\n例: /bet 100 1-2[/info]`); pl.choice = h; } 
                            else if (g.type === 'sicbo') { let h = bM[3]; if (!h || !['dai','shou','any'].includes(h)) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /bet 100 dai[/info]`); pl.choice = h; } 
                            else if (g.type === 'rolet') { let h = bM[3]; if (!h || (!['red','black','even','odd','high','low'].includes(h) && (isNaN(parseInt(h)) || parseInt(h) < 0 || parseInt(h) > 36))) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /bet 100 red[/info]`); pl.choice = h; }
                            pl.bet = b; let updates = { money: myMoney - b };
                            if (player.life_bet_unlocked) { updates.life_bet_unlocked = false; sendTempMessage(roomId, `[info]※通常のベットを行ったため、命賭けの権利は消滅しました。[/info]`); }
                            await supabase.from('players').update(updates).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${formatNumber(b)} コインをベットしました！[/info]`);
                            checkGameProgress(roomId);
                        } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
                    }
                }
                return;
            }

            if ((body.trim().toLowerCase() === 'yes' || body.trim().toLowerCase() === 'no') && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.pendingLifeBet) {
                    if (body.trim().toLowerCase() === 'yes') {
                        pl.isLifeBet = true; if (pl.pendingChoice) pl.choice = pl.pendingChoice;
                        pl.lifeBetBaseAmount = myMoney + myBank; pl.bet = pl.lifeBetBaseAmount > 0 ? pl.lifeBetBaseAmount : 1; 
                        await supabase.from('players').update({ money: 0, bank: 0, life_bet_unlocked: false }).eq('account_id', senderId);
                        pl.pendingLifeBet = false; sendTempMessage(roomId, `[info]💀 [piconname:${senderId}] が命を賭けました！[/info]`);
                        checkGameProgress(roomId);
                    } else {
                        pl.pendingLifeBet = false; sendTempMessage(roomId, `[info]💨 [piconname:${senderId}] が命賭けをキャンセルしました。[/info]`);
                    }
                    return;
                }
            }
// --- 前半ここまで ---



// --- 後半ここから ---
            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().slice(1); 
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    checkGameProgress(roomId); 
                }
            }

            if (/(^|\n)\/shoot\b/.test(body) && gambleActive && gameState[roomId]?.type === 'russian' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId], pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    await sendMessage(roomId, `[info]🔫 [piconname:${pl.aid}] がこめかみに銃を当て、引き金を引いた……[/info]`);
                    await sleep(2000);
                    if (g.currentChamber === g.bulletPos) {
                        await sendMessage(roomId, `[info]💥 バァン！！！\n\n[piconname:${pl.aid}] は撃ち抜かれてしまった……[/info]`);
                        pl.status = 'bust'; await sleep(1500); await resolveRussian(roomId);
                    } else {
                        await sendMessage(roomId, `[info]カチャッ……\n\nセーフ！[/info]`);
                        g.currentChamber++; g.turnIndex = (g.turnIndex + 1) % 2;
                        let nextPl = g.players[g.turnIndex];
                        await sendTempMessage(roomId, `[info][title]🔫 ロシアンルーレット[/title][piconname:${nextPl.aid}] の番です。\n/shoot を入力してください。[/info]`);
                        startGameTimer(roomId, 60000);
                    }
                }
            }

            if (/(^|\n)\/roll\b/.test(body) && gambleActive && gameState[roomId]?.state === 'ACTION') {
                let g = gameState[roomId];
                if (g.type === 'cc') {
                    let pl = g.players.find(x => x.aid === senderId);
                    if (pl && !pl.res) {
                        pl.res = generateChinchiroRoll(); 
                        await playAnimation(roomId, `[info]🎲 [piconname:${senderId}] サイコロを振っています...[/info]`, (i) => {
                            let tempD = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                            return `[info]🎲 [piconname:${senderId}] サイコロを振っています...\n[ ${tempD.join(', ')} ][/info]`;
                        }, 8, 400, `[info]🎲 [piconname:${senderId}] の出目: [ ${pl.res.dice.join(', ')} ] ➡ 『 ${pl.res.name} 』[/info]`);
                        checkGameProgress(roomId);
                    }
                } else if (g.type === 'yacht') {
                    let pl = g.players[g.turnIndex];
                    if (pl && pl.aid === senderId && pl.status === 'playing' && pl.rolls === 0) {
                        pl.dice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); pl.rolls = 1;
                        await playAnimation(roomId, `[info]🎲 [piconname:${pl.aid}] サイコロを振っています...[/info]`, (i) => {
                            let tempD = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
                            return `[info]🎲 [piconname:${pl.aid}] サイコロを振っています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`;
                        }, 8, 400, `[info]🎲 [piconname:${pl.aid}] サイコロを振りました。\n[ ${pl.dice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
                        await sleep(1000); await proceedNextYachtTurn(roomId);
                    }
                }
            }

            if (body.match(/(^|\n)\/change\b/) && gambleActive && (gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId], pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    let match = body.match(/(^|\n)\/change\s+([0-9\s]+)/);
                    if (match) {
                        let nums = match[2].trim().split(/\s+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 5);
                        if (g.type === 'poker') {
                            for (let n of nums) pl.hand[n-1] = g.deck.pop();
                            pl.status = 'stand';
                            let handStr = pl.hand.map(c => c.suit + c.rank).join(' '), ev = getPokerRank(pl.hand);
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 交換完了\n確定手札: ${handStr} (${ev.name})[/info]`);
                            g.turnIndex++; await proceedNextPokerTurn(roomId);
                        } else if (g.type === 'yacht') {
                            nums.forEach(idx => pl.dice[idx-1] = Math.floor(Math.random() * 6) + 1); pl.rolls++;
                            await playAnimation(roomId, `[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...[/info]`, (i) => {
                                let tempD = [...pl.dice]; nums.forEach(idx => tempD[idx-1] = Math.floor(Math.random()*6)+1);
                                return `[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`;
                            }, 8, 400, `[info]🎲 [piconname:${pl.aid}] サイコロを振り直しました。(${pl.rolls}回目)\n[ ${pl.dice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
                            
                            if (pl.rolls >= 3) {
                                pl.status = 'stand';
                                let diceStr = pl.dice.map(d => `🎲${d}`).join(' '), ev = getYachtRank(pl.dice);
                                await sendMessage(roomId, `[info][piconname:${pl.aid}] 3回目の振り直し完了！\n確定サイコロ: ${diceStr} (${ev.name})[/info]`);
                                g.turnIndex++; await proceedNextYachtTurn(roomId);
                            } else {
                                let diceStr = pl.dice.map((d, i) => `[${i+1}] 🎲${d}`).join('   '), ev = getYachtRank(pl.dice);
                                await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン継続 ( ${pl.rolls}/3 回目 )[/title][piconname:${pl.aid}]\nサイコロ: ${diceStr} (${ev.name})\n\n/change [番号] または /stand[/info]`);
                                startGameTimer(roomId, 60000);
                            }
                        }
                    } else await sendTempMessage(roomId, `[info]⚠️ 交換/振り直す番号(1〜5)を指定してください。\n例: /change 1 3 5\nそのまま確定する場合は /stand[/info]`);
                }
            }

            const isHitOrStand = /(^|\n)\/hit\b/.test(body) || /(^|\n)\/stand\b/.test(body);
            if (isHitOrStand && gambleActive && (gameState[roomId]?.type === 'bj' || gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId], pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (/(^|\n)\/hit\b/.test(body)) {
                        if (g.type !== 'bj') return;
                        let c = g.deck.pop(); pl.hand.push(c);
                        let score = calculateBJScore(pl.hand), hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        if (score > 21) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else if (score === 21) {
                            pl.status = 'stand';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n\n/hit または /stand[/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (/(^|\n)\/stand\b/.test(body)) {
                        pl.status = 'stand'; let desc = '';
                        if (g.type === 'poker') desc = `確定手札: ${pl.hand.map(c => c.suit + c.rank).join(' ')} (${getPokerRank(pl.hand).name})`;
                        else if (g.type === 'yacht') desc = `確定サイコロ: ${pl.dice.map(d => `🎲${d}`).join(' ')} (${getYachtRank(pl.dice).name})`;
                        else desc = `スコア: ${calculateBJScore(pl.hand)}`;
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。\n${desc}[/info]`);
                        g.turnIndex++; 
                        if (g.type === 'poker') await proceedNextPokerTurn(roomId);
                        else if (g.type === 'yacht') await proceedNextYachtTurn(roomId);
                        else await proceedNextBJTurn(roomId);
                    }
                }
            }

            const isDrawOrStand = /(^|\n)\/draw\b/.test(body) || /(^|\n)\/stand\b/.test(body);
            if (isDrawOrStand && gambleActive && gameState[roomId]?.type === 'buta' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId], pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (/(^|\n)\/draw\b/.test(body)) {
                        let c = g.deck.pop(), prevCard = pl.hand[pl.hand.length - 1]; pl.hand.push(c);
                        let hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        if (c.suit === prevCard.suit) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n場: ${hStr}\n💥 同じマークが出ました！ドボン！[/info]`);
                            g.turnIndex++; await proceedNextButaTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🐷 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n場: ${hStr} (枚数: ${pl.hand.length})\n\n/draw または /stand[/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (/(^|\n)\/stand\b/.test(body)) {
                        pl.status = 'stand';
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。\n確定枚数: ${pl.hand.length}[/info]`);
                        g.turnIndex++; await proceedNextButaTurn(roomId);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

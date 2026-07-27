const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client Init ---
const chatworkClient = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; 
const daifugoRooms = {}; 
let BOT_ACCOUNT_ID = null;
let lastActiveRoomId = null;

let ownerSkill = { aid: null, expire: 0 };

chatworkClient.get('/me').then(res => { BOT_ACCOUNT_ID = res.data.account_id.toString(); }).catch(()=>{});

const initRealStocks = {
    'ディズニー': { price: 10000, history: [10000], totalIssued: 0, vol: 0.1 },
    '日産': { price: 500, history: [500], totalIssued: 0, vol: 0.15 },
    'ベンツ': { price: 7000, history: [7000], totalIssued: 0, vol: 0.08 },
    'アップル': { price: 20000, history: [20000], totalIssued: 0, vol: 0.12 },
    'ハブ': { price: 800, history: [800], totalIssued: 0, vol: 0.2 },
    'トヨタ': { price: 3000, history: [3000], totalIssued: 0, vol: 0.05 },
    'ソニー': { price: 13000, history: [13000], totalIssued: 0, vol: 0.09 },
    '任天堂': { price: 8000, history: [8000], totalIssued: 0, vol: 0.11 },
    'マクドナルド': { price: 6000, history: [6000], totalIssued: 0, vol: 0.06 },
    'アマゾン': { price: 18000, history: [18000], totalIssued: 0, vol: 0.13 },
    'KADOKAWA': { symbol: '9468.T', curr: 'JPY', defaultPrice: 3000 }
};

const realStockTickers = {
    'ディズニー': { symbol: 'DIS', curr: 'USD' },
    '日産': { symbol: '7201.T', curr: 'JPY' },
    'ベンツ': { symbol: 'MBG.DE', curr: 'EUR' },
    'アップル': { symbol: 'AAPL', curr: 'USD' },
    'ハブ': { symbol: '3030.T', curr: 'JPY' },
    'トヨタ': { symbol: '7203.T', curr: 'JPY' },
    'ソニー': { symbol: '6758.T', curr: 'JPY' },
    '任天堂': { symbol: '7974.T', curr: 'JPY' },
    'マクドナルド': { symbol: 'MCD', curr: 'USD' },
    'アマゾン': { symbol: 'AMZN', curr: 'USD' },
    'KADOKAWA': { symbol: '9468.T', curr: 'JPY' }
};

let kabuData = { price: 3000, history: [3000], totalIssued: 0, lastUpdate: Date.now(), pendingProfit: 0, realStocks: {} };

supabase.from('config').select('*').in('key', ['gamble_active', 'kabu_data']).then(r => {
    if (r.data) {
        let ga = r.data.find(x => x.key === 'gamble_active');
        if (ga) gambleActive = ga.value === 'true';
        let kd = r.data.find(x => x.key === 'kabu_data');
        if (kd) {
            let parsed = JSON.parse(kd.value);
            kabuData = { ...kabuData, ...parsed };
            if (!kabuData.realStocks) kabuData.realStocks = {};
            for (let k in realStockTickers) {
                if (!kabuData.realStocks[k]) {
                    kabuData.realStocks[k] = { price: initRealStocks[k] ? initRealStocks[k].price : 3000, totalIssued: 0 };
                }
            }
        }
    }
}).catch(()=>{});

// --- Date & Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNumber = (n) => Number(n).toLocaleString();
const sleep = ms => new Promise(res => setTimeout(res, ms));
const getDiffDays = (d1Str, d2Str) => {
    if (!d1Str || !d2Str) return 0;
    const d1 = new Date(d1Str);
    const d2 = new Date(d2Str);
    return Math.floor((d2 - d1) / 86400000);
};

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

const makeReplyTag = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendMessage = async (roomId, text) => {
    try { await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`); } catch(e){}
};

const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res && res.data && res.data.message_id) {
            setTimeout(() => chatworkClient.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}), ms);
        }
    } catch(e) {}
};

const editMessage = async (roomId, messageId, text) => {
    try { await chatworkClient.put(`/rooms/${roomId}/messages/${messageId}`, `body=${encodeURIComponent(text)}`); } catch(e) {}
};

const calculateNetWorth = (p) => {
    let tMoney = p.money || 0;
    let tBank = p.bank || 0;
    let totalStockValue = (p.kabu_owned || 0) * kabuData.price;
    if (p.stocks && kabuData.realStocks) {
        let s = JSON.parse(p.stocks);
        for (let k in s) {
            if (kabuData.realStocks[k]) {
                totalStockValue += s[k] * kabuData.realStocks[k].price;
            }
        }
    }
    return tMoney + tBank + totalStockValue;
};

// --- 金曜夜のビンゴ大会 ---
let bingoExecutedDate = null;
setInterval(async () => {
    let now = new Date(Date.now() + 32400000);
    let day = now.getDay();
    let hour = now.getHours();
    let dateStr = now.toISOString().split('T')[0];

    if (day === 5 && hour >= 20 && hour < 23) {
        if (bingoExecutedDate !== dateStr) {
            if (hour === 21 && now.getMinutes() === 0) {
                bingoExecutedDate = dateStr;
                const { data: activePlayers } = await supabase.from('players').select('account_id').eq('last_daily_date', dateStr);
                if (activePlayers && activePlayers.length > 0) {
                    let winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];
                    let prize = Math.floor(Math.random() * 2000000) + 1000000;
                    await addMoney(winner.account_id, prize);
                    if (lastActiveRoomId) {
                        sendMessage(lastActiveRoomId, `[info][title]🎉 金曜夜のビンゴ大会！[/title]今週のラッキーユーザーは... [piconname:${winner.account_id}] さんです！\n見事ビンゴし、賞金 ${formatNumber(prize)} コインを獲得しました！[/info]`);
                    }
                }
            }
        }
    }
}, 60000);

// --- 為替・株価 ---
const fetchExchangeRates = async () => {
    try {
        const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
        if (res.data && res.data.rates) {
            let usdJpy = res.data.rates.JPY;
            let eurUsd = res.data.rates.EUR; 
            let eurJpy = usdJpy / eurUsd;
            return { usd: usdJpy, eur: eurJpy };
        }
    } catch(e) {}
    return { usd: 150, eur: 160 };
};

const fetchStockData = async (tickerInfo, range = '1d') => {
    let interval = '15m';
    if (range === '1w') { range = '5d'; interval = '15m'; }
    else if (range === '1m') { range = '1mo'; interval = '1d'; }
    else if (range === '1y') { range = '1y'; interval = '1wk'; }
    else { range = '1d'; interval = '5m'; }

    try {
        const res = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${tickerInfo.symbol}?range=${range}&interval=${interval}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        if (res.data && res.data.chart && res.data.chart.result && res.data.chart.result.length > 0) {
            const result = res.data.chart.result[0];
            const currentPrice = result.meta.regularMarketPrice;
            const quotes = result.indicators.quote[0].close || [];
            let history = quotes.filter(v => v !== null);
            
            let rate = 1;
            if (tickerInfo.curr !== 'JPY') {
                const rates = await fetchExchangeRates();
                if (tickerInfo.curr === 'USD') rate = rates.usd;
                if (tickerInfo.curr === 'EUR') rate = rates.eur;
            }
            
            return {
                price: Math.floor(currentPrice * rate),
                history: history.map(v => Math.floor(v * rate))
            };
        }
    } catch(e) {}
    return null;
};

const updateKabuPrice = async () => {
    let now = Date.now();
    let hoursPassed = Math.floor((now - kabuData.lastUpdate) / 3600000);
    if (hoursPassed > 0) {
        for (let i = 0; i < hoursPassed; i++) {
            let changePercent = 0;
            if (i === 0) {
                changePercent = ((kabuData.pendingProfit || 0) / 500000) * 0.05;
                kabuData.pendingProfit = 0;
            }

            if (changePercent > 0.15) changePercent = 0.15;
            if (changePercent < -0.15) changePercent = -0.15;

            let noise = (Math.random() * 0.04) - 0.02;
            changePercent += noise;

            if (changePercent > 0.15) changePercent = 0.15;
            if (changePercent < -0.15) changePercent = -0.15;
            
            kabuData.price += Math.floor(kabuData.price * changePercent);
            if (kabuData.price < 100) kabuData.price = 100;
            if (kabuData.price > 1000000) kabuData.price = 1000000;
            kabuData.history.push(kabuData.price);
        }
        kabuData.lastUpdate = now;
        if (kabuData.history.length > 24) kabuData.history = kabuData.history.slice(-24);
        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    }
};

// --- お金・戦績管理・アイテム管理 ---
const consumeItem = async (aid, itemName) => {
    let { data: p } = await supabase.from('players').select('items').eq('account_id', aid).single();
    if (!p) return false;
    let items = typeof p.items === 'string' ? JSON.parse(p.items || '{}') : (p.items || {});
    if (items[itemName] > 0) {
        items[itemName]--;
        await supabase.from('players').update({ items: JSON.stringify(items) }).eq('account_id', aid);
        return true;
    }
    return false;
};

const addMoney = async (accountId, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', accountId).single();
    let money = p ? (p.money || 0) : 0;
    let bank = p ? (p.bank || 0) : 0;
    let kabu_owned = p ? (p.kabu_owned || 0) : 0;
    let rtt = p ? (p.russian_trauma_time || 0) : 0;
    let stocks = p ? (p.stocks || '{}') : '{}';
    let ds = p ? (p.daily_start_networth || 0) : 0;
    let ls = p ? (p.login_streak || 0) : 0;
    let items = p ? (p.items || '{}') : '{}';
    let js = p ? (p.job_state || '{}') : '{}';
    
    money += amount;

    if (p) {
        await supabase.from('players').update({ money: money, debt: 0 }).eq('account_id', accountId);
    } else {
        await supabase.from('players').insert({ 
            account_id: accountId, money: money, bank: bank, debt: 0, 
            slot_count: 0, work_limit: 10, msg_count: 0, job: 'サラリーマン', 
            win_streak: 0, life_bet_unlocked: false, kabu_owned: kabu_owned,
            plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0, russian_trauma_time: rtt,
            stocks: stocks, last_daily_date: null, login_streak: ls, daily_start_networth: ds,
            items: items, job_state: js
        });
    }
};

const updatePlayerStats = async (accountId, betAmount, returnAmount, resultType) => {
    const { data: p } = await supabase.from('players').select('plays, wins, loses, total_bet, total_return').eq('account_id', accountId).single();
    if (!p) return;
    let plays = (p.plays || 0) + 1;
    let wins = p.wins || 0;
    let loses = p.loses || 0;
    if (resultType === 'win') wins++;
    else if (resultType === 'lose') loses++;
    
    let total_bet = (p.total_bet || 0) + Math.abs(betAmount);
    let total_return = (p.total_return || 0) + Math.abs(returnAmount);
    
    await supabase.from('players').update({ plays, wins, loses, total_bet, total_return }).eq('account_id', accountId);
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
            setTimeout(() => { sendMessage(roomId, `[info][piconname:${accountId}]\nなんだろ…いまならいける気がする…\n(※次回のゲームで特別に /#bet life が使用可能になりました！)[/info]`); }, 1000);
        }
        await supabase.from('players').update(updates).eq('account_id', accountId);
    } else if (result === 'lose') {
        await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', accountId);
    }
};

const checkTrauma = (p) => {
    if (!p || !p.russian_trauma_time) return 0;
    const passed = Date.now() - Number(p.russian_trauma_time);
    if (passed < 60000) return Math.ceil((60000 - passed) / 1000);
    return 0;
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
            admins = admins.filter(x => x !== id);
            members = members.filter(x => x !== id);
            readonlys = readonlys.filter(x => x !== id);
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

// --- スキル・特殊処理 ---
const processOwnerSkill = async (loserAid, lostAmount, roomId) => {
    let now = Date.now();
    if (ownerSkill.expire > now && ownerSkill.aid && ownerSkill.aid !== loserAid.toString()) {
        if (Math.random() < 0.5) { 
            let stealAmount = Math.floor(lostAmount * 0.5); 
            if (stealAmount > 0) {
                await addMoney(ownerSkill.aid, stealAmount);
                sendMessage(roomId, `[info]👑 ギャンブルオーナーの不労所得！\n[piconname:${ownerSkill.aid}] が [piconname:${loserAid}] の負け金から ${formatNumber(stealAmount)} コインを回収しました。[/info]`);
            }
        }
    }
};

const processGamblerSkill = async (aid, lostAmount, roomId) => {
    const { data: p } = await supabase.from('players').select('job, total_bet, total_return').eq('account_id', aid).single();
    if (!p || p.job !== '逆転のギャンブラー') return false;
    
    let currentRTP = p.total_bet > 0 ? (p.total_return / p.total_bet) * 100 : 0;
    let threshold = Math.floor(Math.random() * 21) + 30; // 30〜50

    if (currentRTP <= threshold) {
        if (Math.random() < 0.8) {
            await addMoney(aid, lostAmount);
            await updatePlayerStats(aid, 0, lostAmount, 'draw'); 
            sendMessage(roomId, `[info]🔄 逆転のギャンブラー発動！\n[piconname:${aid}] 崖っぷちの運命が覆り、負け金 ${formatNumber(lostAmount)} コインが返還されました！[/info]`);
            return true;
        }
    }
    return false;
};

const processBounty = async (loserAid, lostAmount, roomId) => {
    const { data: hunters } = await supabase.from('players').select('account_id, job_state').eq('job', '賞金稼ぎ');
    if (hunters) {
        for (let h of hunters) {
            let js = typeof h.job_state === 'string' ? JSON.parse(h.job_state||'{}') : (h.job_state||{});
            if (js.bounty_target === loserAid.toString()) {
                let reward = Math.floor(lostAmount * 0.1);
                if (reward > 0) {
                    await addMoney(h.account_id, reward);
                    sendMessage(roomId, `[info]🎯 賞金稼ぎ発動！\n[piconname:${h.account_id}] がターゲット([piconname:${loserAid}])の敗北から ${formatNumber(reward)} コインを奪いました！[/info]`);
                }
            }
        }
    }
};

const processJoker = async (winnerAid, winAmt, roomId) => {
    let stolen = 0;
    const { data: jokers } = await supabase.from('players').select('account_id, job_state');
    if (jokers) {
        for (let j of jokers) {
            let js = typeof j.job_state === 'string' ? JSON.parse(j.job_state||'{}') : (j.job_state||{});
            if (js.joker_target === winnerAid.toString()) {
                let pct = (Math.floor(Math.random() * 11) + 10) / 100;
                let steal = Math.floor(winAmt * pct);
                if (steal > 0) {
                    await addMoney(j.account_id, steal);
                    stolen += steal;
                    js.joker_target = null;
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', j.account_id);
                    sendMessage(roomId, `[info]🃏 ジョーカーの罠発動！\n[piconname:${j.account_id}] が [piconname:${winnerAid}] の勝利配当から ${formatNumber(steal)} コインを横取りしました！[/info]`);
                }
            }
        }
    }
    return stolen;
};

const processButler = async (earnerAid, winAmt, roomId) => {
    if (winAmt < 1000000) return;
    const { data: allP } = await supabase.from('players').select('account_id, money, bank, kabu_owned, job');
    if (!allP) return;
    let price = kabuData.price || 1000;
    allP.sort((a,b) => ((b.money||0) + (b.bank||0) + ((b.kabu_owned||0)*price)) - ((a.money||0) + (a.bank||0) + ((a.kabu_owned||0)*price)));
    
    if (allP.length > 0 && allP[0].account_id.toString() === earnerAid.toString()) {
        let reward = Math.floor(winAmt * 0.01);
        if (reward <= 0) return;
        const butlers = allP.filter(p => p.job === '大富豪の執事');
        for (let b of butlers) {
            await addMoney(b.account_id, reward);
            sendMessage(roomId, `[info]🎩 執事の給料\n主([piconname:${earnerAid}])が100万以上稼いだため、執事の [piconname:${b.account_id}] に給料 ${formatNumber(reward)} コインが支払われました。[/info]`);
        }
    }
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
    let stats = []; 
    for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0, oddsMap = {}, oddsStr = "";
    for(let i=1; i<=5; i++){
        for(let j=i+1; j<=6; j++){
            let w = stats[i-1] * stats[j-1]; combos.push({ combo: `${i}-${j}`, weight: w }); totalWeight += w;
        }
    }
    combos.forEach(c => {
        let odd = (0.8 / (c.weight / totalWeight)).toFixed(1);
        oddsMap[c.combo] = odd < 1.1 ? 1.1 : (odd > 150 ? 150.0 : Number(odd));
    });
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
    hand.forEach(c => {
        let v = (c.rank === 'A') ? 14 : (['J','Q','K'].includes(c.rank) ? [11,12,13][['J','Q','K'].indexOf(c.rank)] : parseInt(c.rank));
        vals.push(v); rc[v] = (rc[v] || 0) + 1; sc[c.suit] = (sc[c.suit] || 0) + 1;
    });
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
    hand.forEach((c, i) => {
        let v = c.rank === 'A' ? 14 : (['J','Q','K'].includes(c.rank) ? [11,12,13][['J','Q','K'].indexOf(c.rank)] : parseInt(c.rank));
        if(!counts[v]) counts[v] = [];
        counts[v].push(i);
    });
    let keep = []; let maxV = 0; let maxVIdx = 0;
    for (let v in counts) {
        if (counts[v].length >= 2) keep.push(...counts[v]); 
        if (parseInt(v) > maxV) { maxV = parseInt(v); maxVIdx = counts[v][0]; }
    }
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
    if (keep.length === 0) {
        let maxD = 0, maxI = 0;
        dice.forEach((d, i) => { if (d > maxD) { maxD = d; maxI = i; }});
        keep.push(maxI);
    }
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
    try {
        const r = await chatworkClient.post('/rooms', params.toString());
        const newRoomId = r.data.room_id.toString();
        daifugoRooms[newRoomId] = { mainRoomId, aid };
        return newRoomId;
    } catch(e) { return null; }
};

const deleteDaifugoRoom = async (pRoomId) => {
    try {
        const params = new URLSearchParams();
        params.append('action_type', 'delete');
        await chatworkClient.delete(`/rooms/${pRoomId}`, { data: params.toString() });
        delete daifugoRooms[pRoomId];
    } catch(e) {}
};

const createDaifugoDeck = () => {
    const suits = ['♠','♥','♦','♣'], ranks = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
    let d = [];
    for(let s of suits) for(let r of ranks) d.push(s+r);
    d.push('JOKER');
    return d.sort(()=>Math.random()-0.5);
};

const getDaifugoVal = (cardStr) => {
    if (cardStr === 'JOKER') return 16;
    let r = cardStr.slice(1);
    if (r==='A') return 14; if (r==='2') return 15;
    if (r==='J') return 11; if (r==='Q') return 12; if (r==='K') return 13;
    return parseInt(r);
};

const parseDaifugoPlay = (playStrs, handStrs, field, isKakumei, isJBack) => {
    for(let c of playStrs) if(!handStrs.includes(c)) return {valid:false, msg:'手札に無いカードです'};
    let vals = playStrs.map(c => getDaifugoVal(c)).sort((a,b)=>a-b);
    let type = '';
    if (playStrs.length === 1) type = 'single';
    else if (vals.every(v => v === vals[0] || v === 16)) type = 'pair';
    else return {valid:false, msg:'単発かペアのみ対応しています'};

    let baseVal = vals.find(v => v !== 16) || 16;
    let rev = isKakumei !== isJBack; 
    
    if (field) {
        if (field.count !== playStrs.length) return {valid:false, msg:'場の枚数と違います'};
        if (field.type !== type) return {valid:false, msg:'場の役と違います'};
        let validVal = false;
        if (rev) { validVal = baseVal < field.val; if(playStrs.includes('JOKER')) validVal = true; } 
        else { validVal = baseVal > field.val; if(playStrs.includes('JOKER')) validVal = true; }
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
    
    if (isDerby) {
        game.remindId = setTimeout(() => {
            if (gameState[roomId] && gameState[roomId].state === 'BETTING') {
                sendTempMessage(roomId, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は /#bet [額] [馬番-馬番] を入力してください。[/info]`);
            }
        }, ms - 60000);
    }
    game.timeoutId = setTimeout(() => handleGameTimeout(roomId), ms);
};

const handleGameTimeout = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        let isEnoughPlayers = game.type === 'russian' ? (game.players.length >= 2) : (game.players.length >= 1);
        
        if (isEnoughPlayers) {
            game.state = 'BETTING';
            
            if (game.type === 'russian') {
                let shuffled = [...game.players].sort(() => Math.random() - 0.5);
                game.players = shuffled.slice(0, 2);
                game.spectators = shuffled.slice(2).map(p => ({ aid: p.aid, bet: 0, targetAid: null }));

                let specTxt = game.spectators.length > 0 ? `\n👀 観戦者(${game.spectators.length}名)の方は /#bet [額] [aid] (または返信) で勝者を予想してください！` : ``;
                let pTxt = `🔫 プレイヤー:\n1. [piconname:${game.players[0].aid}]\n2. [piconname:${game.players[1].aid}]`;
                
                await sendTempMessage(roomId, `[info][title]🔫 ロシアンルーレット ベット開始[/title]抽選でプレイヤーが確定しました。\n\n${pTxt}\n\nプレイヤーは /#bet [額] を入力してください。(※相手の全財産の半分未満)\n${specTxt}\n[hr](制限1分)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]/#bet [額] [馬1]-[馬2] (例: /#bet 100 1-2)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else if (game.type === 'crash') {
                let ex = `/#bet [額] [目標倍率(1.01以上)] (例: /#bet 100 2.5)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /#bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'highlow') {
                let ex = `/#bet [額] high か /#bet [額] low`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /#bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'sicbo') {
                let ex = `/#bet [額] dai か /#bet [額] shou か /#bet [額] any`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /#bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'rolet') {
                let ex = `/#bet [額] [予想] (red/black/even/odd/high/low/数字)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /#bet life も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else {
                let ex = `/#bet [額] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /#bet life や /#bet max も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が規定人数未満のため、ゲームを中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else if (game.state === 'BETTING') {
        let kickedAids = [], activePlayers = [];
        for (let player of game.players) {
            if (player.bet === 0 && !player.isLifeBet) kickedAids.push(player.aid);
            else activePlayers.push(player);
        }
        game.players = activePlayers;

        let activeSpectators = [];
        if (game.spectators) {
            for (let spec of game.spectators) {
                if (spec.bet === 0) kickedAids.push(spec.aid);
                else activeSpectators.push(spec);
            }
            game.spectators = activeSpectators;
        }
        
        if (kickedAids.length > 0) {
            await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、未ベットのユーザーをキックしました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        }
        
        let isEnoughPlayers = game.type === 'russian' ? (game.players.length >= 2) : (game.players.length >= 1);
        if (!isEnoughPlayers) {
            for (let player of game.players) {
                if (player.bet > 0) {
                    if (player.isLifeBet) await addMoney(player.aid, player.lifeBetBaseAmount); 
                    else await addMoney(player.aid, player.bet); 
                }
            }
            if (game.spectators) {
                for (let spec of game.spectators) {
                    if (spec.bet > 0) await addMoney(spec.aid, spec.bet);
                }
            }
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]残りの参加者が規定人数未満になったため中止し、全額返金しました。[/info]`);
            gameState[roomId] = null;
        } else {
            await checkGameProgress(roomId);
        }
    } else if (game.state === 'ACTION') {
        if (['bj', 'poker', 'yacht', 'buta', 'daifugo'].includes(game.type)) {
            let player = game.players[game.turnIndex];
            if (player && player.status === 'playing') {
                if (game.type === 'daifugo') {
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は強制パスしました。[/info]`);
                    game.daifugo.passCount++;
                    await checkDaifugoNextTurn(roomId);
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
            if (player) {
                await sendTempMessage(roomId, `[info]⏳ タイムアウト！\n\n[piconname:${player.aid}] は恐れをなして逃げ出した…… (敗北扱い)[/info]`);
                let winnerIdx = game.turnIndex === 0 ? 1 : 0;
                let winner = game.players[winnerIdx];
                let totalPot = game.players[0].bet + game.players[1].bet;

                await addMoney(winner.aid, totalPot);
                await updatePlayerStats(winner.aid, winner.bet, totalPot, 'win');
                await updatePlayerStats(player.aid, player.bet, 0, 'lose');
                await updateWinStreak(winner.aid, 'win', roomId);
                await updateWinStreak(player.aid, 'lose', roomId);
                
                await supabase.from('players').update({ russian_trauma_time: Date.now() }).eq('account_id', player.aid);
                
                let specMsg = "";
                if (game.spectators && game.spectators.length > 0) {
                    specMsg = "\n[hr]【 観戦者の結果 】\n";
                    for (let spec of game.spectators) {
                        if (spec.targetAid === winner.aid) {
                            let winAmt = spec.bet * 2;
                            await addMoney(spec.aid, winAmt);
                            await updatePlayerStats(spec.aid, spec.bet, winAmt, 'win');
                            specMsg += `[piconname:${spec.aid}]: 予想的中！ (+${formatNumber(winAmt)})\n`;
                        } else {
                            await updatePlayerStats(spec.aid, spec.bet, 0, 'lose');
                            specMsg += `[piconname:${spec.aid}]: 予想はずれ (没収)\n`;
                        }
                    }
                }

                await sendMessage(roomId, `[info][title]🏆 勝者: [piconname:${winner.aid}][/title]逃げ出さなかった [piconname:${winner.aid}] が相手の賭け金を含めた ${formatNumber(totalPot)} コインを総取りしました！[/info]`);
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
                    if (player.bet > 0) {
                        await processOwnerSkill(player.aid, player.bet, roomId);
                    }
                    if (player.isLifeBet) {
                        await supabase.from('blacklist').insert({ account_id: player.aid });
                        await updateRoomMembers(roomId, [player.aid], 'readonly');
                    }
                } else activePlayers.push(player);
            }
            game.players = activePlayers;
            
            if (kickedAids.length > 0) {
                await sendTempMessage(roomId, `[info][title]⏳ タイムアウト (没収)[/title]時間切れのため未操作のプレイヤーを退出させ、賭け金を没収しました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
            }
            
            let isEnoughPlayers = game.players.length >= 1;
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
    
    let allPlayersBet = game.players.every(p => (p.bet > 0 || p.isLifeBet) && !p.pendingLifeBet);
    let allSpectatorsBet = !game.spectators || game.spectators.every(s => s.bet > 0);

    if (game.state === 'BETTING' && allPlayersBet && allSpectatorsBet) {
        if (game.type === 'russian') {
            game.state = 'ACTION';
            game.bulletPos = Math.floor(Math.random() * 6);
            game.currentChamber = 0;
            game.turnIndex = Math.floor(Math.random() * 2);
            let firstPlayer = game.players[game.turnIndex];
            
            await sendTempMessage(roomId, `[info][title]🔫 ロシアンルーレット 開始[/title]リボルバーに弾を1発込め、シリンダーを回しました。\nｶﾗｶﾗｶﾗ... ﾁｬｷｯ\n\n先攻は [piconname:${firstPlayer.aid}] です。\n /#shoot を入力して引き金を引いてください。\n(制限時間1分)[/info]`);
            startGameTimer(roomId, 60000);
            return;
        }

        if (game.type === 'derby') {
            clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
            await proceedBotDerby(roomId);
        } else if (game.type === 'crash') {
            clearTimeout(game.timeoutId);
            await proceedBotCrash(roomId);
        } else if (game.type === 'highlow') {
            clearTimeout(game.timeoutId);
            await proceedBotHighLow(roomId);
        } else if (game.type === 'sicbo') {
            clearTimeout(game.timeoutId);
            await proceedBotSicbo(roomId);
        } else if (game.type === 'rolet') {
            clearTimeout(game.timeoutId);
            await proceedBotRoulette(roomId);
        } else if (game.type === 'bj') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            game.dealerHand = [game.deck.pop(), game.deck.pop()];
            
            let msg = `[info][title]🃏 ブラックジャック 開始[/title]全員ベット完了！カードを配ります。\n\n【 ディーラー 】\n🎴 ${game.dealerHand[0].suit}${game.dealerHand[0].rank} / [裏]\n[hr]【 プレイヤー 】\n`;
            for (let p of game.players) {
                p.hand = [game.deck.pop(), game.deck.pop()];
                let pScore = calculateBJScore(p.hand);
                let hStr = p.hand.map(c => c.suit + c.rank).join(' ');
                msg += `[piconname:${p.aid}]: ${hStr} (スコア: ${pScore})`;
                if (pScore === 21) { p.status = 'bj'; msg += ` 🎉 ブラックジャック！\n`; } 
                else { p.status = 'playing'; msg += `\n`; }
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextBJTurn(roomId);
        } else if (game.type === 'poker') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            
            let msg = `[info][title]🃏 ポーカー 開始[/title]全員ベット完了！5枚ずつカードを配ります。\n\n`;
            for (let p of game.players) {
                p.hand = [];
                for(let i=0; i<5; i++) p.hand.push(game.deck.pop());
                p.status = 'playing';
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextPokerTurn(roomId);
        } else if (game.type === 'yacht') {
            game.state = 'ACTION';
            for (let p of game.players) { p.dice = []; p.status = 'playing'; p.rolls = 0; }
            await sendTempMessage(roomId, `[info][title]🎲 ヨット 開始[/title]全員のベットが完了しました！\n順番にサイコロを振ります。[/info]`, 120000);
            game.turnIndex = 0;
            await proceedNextYachtTurn(roomId);
        } else if (game.type === 'buta') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            game.dealerHand = [game.deck.pop()];
            
            let msg = `[info][title]🐷 豚のしっぽ 開始[/title]全員ベット完了！最初のカードを配ります。\n\n【 ディーラー 】\n🎴 ${game.dealerHand[0].suit}${game.dealerHand[0].rank}\n[hr]【 プレイヤー 】\n`;
            for (let p of game.players) {
                p.hand = [game.deck.pop()];
                p.status = 'playing';
                let hStr = p.hand.map(c => c.suit + c.rank).join(' ');
                msg += `[piconname:${p.aid}]: ${hStr} (枚数: 1)\n`;
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextButaTurn(roomId);
        } else if (game.type === 'daifugo') {
            game.state = 'ACTION';
            game.deck = createDaifugoDeck();
            game.players.push({ aid: 'bot', status: 'playing', hand: [] });
            
            let totalPlayers = game.players.length;
            for(let i=0; i<53; i++){ game.players[i % totalPlayers].hand.push(game.deck[i]); }
            
            let msg = `[info][title]👑 大富豪 開始[/title]全員ベット完了！\n各プレイヤーの手札専用部屋を作成しました。\n\n`;
            for (let p of game.players) {
                if (p.aid !== 'bot') {
                    p.pRoomId = await createDaifugoRoom(p.aid, roomId);
                    msg += `[piconname:${p.aid}] 様の部屋: https://www.chatwork.com/#!rid${p.pRoomId}\n`;
                    if (p.pRoomId) {
                        let hStr = p.hand.map(c=>`[ ${c} ]`).join(' ');
                        sendMessage(p.pRoomId, `[info][title]🃏 あなたの手札[/title]${hStr}\n\n出せるカードを /#play S3 や /#play H4 D4 のように指定するか、 /#pass してください。[/info]`);
                    }
                }
            }
            msg += `[hr]順番に進行します。手札部屋からコマンドを送信してください。\n[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            
            game.daifugo = { field: null, isKakumei: false, isJBack: false, passCount: 0, rankings: [] };
            game.turnIndex = Math.floor(Math.random() * totalPlayers);
            await checkDaifugoNextTurn(roomId);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 /#chou (丁) または /#han (半) と発言してください。" : "各プレイヤーは /#roll でサイコロを振ってください。";
            await sendTempMessage(roomId, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(roomId, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.every(p => p.choice)) await proceedBotChouhan(roomId);
        if (game.type === 'cc' && game.players.every(p => p.res)) await proceedBotChinchiroTurn(roomId);
    }
};

// --- 大富豪 進行処理 ---
const checkDaifugoNextTurn = async (roomId) => {
    let g = gameState[roomId];
    if (!g || g.type !== 'daifugo') return;

    let activeCount = g.players.filter(p => p.status === 'playing').length;
    if (activeCount <= 1) {
        await resolveDaifugo(roomId);
        return;
    }

    if (g.daifugo.passCount >= activeCount - 1) {
        g.daifugo.field = null;
        g.daifugo.isJBack = false;
        g.daifugo.passCount = 0;
        await sendMessage(roomId, `[info]🔄 全員がパスしました。場が流れます。[/info]`);
    }

    let p = g.players[g.turnIndex];
    while (p.status !== 'playing') {
        g.turnIndex = (g.turnIndex + 1) % g.players.length;
        p = g.players[g.turnIndex];
    }

    let fStr = g.daifugo.field ? `【 ${g.daifugo.field.count} 枚出し (強さ: ${g.daifugo.field.val}) 】` : "【 自由 (空) 】";
    let stateStr = (g.daifugo.isKakumei ? "🔥 革命中！ " : "") + (g.daifugo.isJBack ? "💫 イレブンバック中！" : "");
    
    await sendTempMessage(roomId, `[info]👑 ターン進行: ${p.aid==='bot'?'[ディーラー]':`[piconname:${p.aid}]`} の番です。\n現在の場: ${fStr}\n${stateStr}[/info]`);
    
    if (p.aid === 'bot') {
        setTimeout(() => proceedBotDaifugoTurn(roomId), 2000);
    } else {
        if (p.pRoomId) {
            let hStr = p.hand.map(c=>`[ ${c} ]`).join(' ');
            sendMessage(p.pRoomId, `[info]📣 あなたのターンです！\n場: ${fStr}\n状態: ${stateStr}\n手札: ${hStr}\n\n/#play または /#pass を入力してください。[/info]`);
        }
        startGameTimer(roomId, 60000); 
    }
};

const handleDaifugoAction = async (mainRoomId, aid, body) => {
    let g = gameState[mainRoomId];
    if (!g || g.type !== 'daifugo' || g.state !== 'ACTION') return;
    
    let p = g.players[g.turnIndex];
    if (!p || p.aid !== aid || p.status !== 'playing') return;

    if (body.match(/^[/#]pass(\s|$)/)) {
        g.daifugo.passCount++;
        await sendMessage(mainRoomId, `[info][piconname:${aid}] は パス しました。[/info]`);
        g.turnIndex = (g.turnIndex + 1) % g.players.length;
        await checkDaifugoNextTurn(mainRoomId);
        return;
    }

    let playMatch = body.match(/^[/#]play\s+(.+)$/);
    if (playMatch) {
        let playStrs = playMatch[1].trim().split(/\s+/);
        let res = parseDaifugoPlay(playStrs, p.hand, g.daifugo.field, g.daifugo.isKakumei, g.daifugo.isJBack);
        
        if (!res.valid) {
            sendMessage(p.pRoomId, `[info]⚠️ 出せません: ${res.msg}[/info]`);
            return;
        }

        p.hand = p.hand.filter(c => !playStrs.includes(c));
        g.daifugo.field = res;
        g.daifugo.passCount = 0;

        await sendMessage(mainRoomId, `[info][piconname:${aid}] が 【 ${playStrs.join(' ')} 】 を出しました！ (残り ${p.hand.length}枚)[/info]`);
        
        if (res.isKaku) { g.daifugo.isKakumei = !g.daifugo.isKakumei; await sendMessage(mainRoomId, `[info]🔥 革命発生！！！[/info]`); }
        if (res.isJ) { g.daifugo.isJBack = true; await sendMessage(mainRoomId, `[info]💫 イレブンバック発生！[/info]`); }

        if (p.hand.length === 0) {
            p.status = 'won';
            g.daifugo.rankings.push(p);
            await sendMessage(mainRoomId, `[info]🎉 [piconname:${aid}] が上がりました！[/info]`);
        }

        if (res.is8) {
            await sendMessage(mainRoomId, `[info]✂️ 8切り！ ターン継続！[/info]`);
            g.daifugo.field = null;
            g.daifugo.isJBack = false;
            await checkDaifugoNextTurn(mainRoomId);
            return;
        }

        g.turnIndex = (g.turnIndex + 1) % g.players.length;
        await checkDaifugoNextTurn(mainRoomId);
    }
};

const proceedBotDaifugoTurn = async (roomId) => {
    let g = gameState[roomId];
    if (!g || g.type !== 'daifugo') return;
    let p = g.players[g.turnIndex];

    let rev = g.daifugo.isKakumei !== g.daifugo.isJBack;
    p.hand.sort((a,b) => rev ? getDaifugoVal(b) - getDaifugoVal(a) : getDaifugoVal(a) - getDaifugoVal(b)); 

    let playStrs = [];
    if (!g.daifugo.field) {
        playStrs.push(p.hand[0]);
    } else {
        let f = g.daifugo.field;
        let cCounts = {};
        p.hand.forEach(c => { let v = getDaifugoVal(c); cCounts[v] = (cCounts[v]||[]); cCounts[v].push(c); });
        
        for (let v in cCounts) {
            let numV = parseInt(v);
            let canBeat = rev ? numV < f.val : numV > f.val;
            if (numV === 16) canBeat = true; 
            
            if (cCounts[v].length >= f.count && canBeat) {
                playStrs = cCounts[v].slice(0, f.count);
                break;
            }
        }
    }

    if (playStrs.length > 0) {
        let res = parseDaifugoPlay(playStrs, p.hand, g.daifugo.field, g.daifugo.isKakumei, g.daifugo.isJBack);
        p.hand = p.hand.filter(c => !playStrs.includes(c));
        g.daifugo.field = res;
        g.daifugo.passCount = 0;
        await sendMessage(roomId, `[info]🤖 ディーラーが 【 ${playStrs.join(' ')} 】 を出しました！ (残り ${p.hand.length}枚)[/info]`);
        
        if (res.isKaku) { g.daifugo.isKakumei = !g.daifugo.isKakumei; await sendMessage(roomId, `[info]🔥 革命発生！！！[/info]`); }
        if (res.isJ) { g.daifugo.isJBack = true; await sendMessage(roomId, `[info]💫 イレブンバック発生！[/info]`); }

        if (p.hand.length === 0) {
            p.status = 'won';
            g.daifugo.rankings.push(p);
            await sendMessage(roomId, `[info]🎉 ディーラーが上がりました！[/info]`);
        }

        if (res.is8) {
            await sendMessage(roomId, `[info]✂️ 8切り！ ディーラーのターンが継続します。[/info]`);
            g.daifugo.field = null;
            g.daifugo.isJBack = false;
            setTimeout(() => checkDaifugoNextTurn(roomId), 1500);
            return;
        }
    } else {
        g.daifugo.passCount++;
        await sendMessage(roomId, `[info]🤖 ディーラーは パス しました。[/info]`);
    }

    g.turnIndex = (g.turnIndex + 1) % g.players.length;
    await checkDaifugoNextTurn(roomId);
};

// --- ボットアクション系 ---
const proceedNextBJTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'bj') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let score = calculateBJScore(player.hand);
        let handStr = player.hand.map(c => c.suit + c.rank).join(' ');
        await sendTempMessage(roomId, `[info][title]🃏 ターン進行[/title][piconname:${player.aid}] さんの番です！\n手札: ${handStr} (スコア: ${score})\n\n/#hit (引く) または /#stand (引かない) を入力してください。\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await proceedBotBJTurn(roomId);
};

const proceedBotBJTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    let dHand = game.dealerHand;
    let dScore = calculateBJScore(dHand);
    
    await sendMessage(roomId, `[info][ディーラー] のターンです。\n伏せカードをめくります...[/info]`);
    await sleep(2000);
    
    while (dScore < 17) {
        let hStr = dHand.map(c => c.suit + c.rank).join(' ');
        await sendMessage(roomId, `[info][ディーラー] 手札: ${hStr} (スコア: ${dScore})[/info]`);
        await sleep(1500);
        await sendMessage(roomId, `/#hit`);
        await sleep(1000);
        
        let c = game.deck.pop(); 
        dHand.push(c); 
        dScore = calculateBJScore(dHand);
        await sendMessage(roomId, `[info]🃏 [ディーラー] 『 ${c.suit}${c.rank} 』 を引きました。[/info]`);
        await sleep(1500);
    }
    
    let hStr = dHand.map(c => c.suit + c.rank).join(' ');
    if (dScore > 21) {
        await sendMessage(roomId, `[info][ディーラー] 手札: ${hStr} (スコア: ${dScore})\n💥 ディーラーがバーストしました！[/info]`);
    } else {
        await sendMessage(roomId, `[info][ディーラー] 手札: ${hStr} (スコア: ${dScore})[/info]`);
        await sleep(1500);
        await sendMessage(roomId, `/#stand`);
        await sleep(1000);
        await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    }
    await sleep(2000);
    await resolveBJ(roomId);
};

const proceedNextPokerTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'poker') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let handStr = player.hand.map((c, i) => `[${i+1}] ${c.suit}${c.rank}`).join('   ');
        let ev = getPokerRank(player.hand);
        
        await sendTempMessage(roomId, `[info][title]🃏 ポーカー ターン進行[/title][piconname:${player.aid}] さんの番です！\n手札:\n${handStr}\n(現状の役: ${ev.name})\n\n交換するカードの番号を指定してください。交換しない場合は /#stand\n例: /#change 1 3 5\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await proceedBotPokerTurn(roomId);
};

const proceedBotPokerTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;

    game.botHand = [];
    for(let i=0; i<5; i++) game.botHand.push(game.deck.pop());
    
    await sendMessage(roomId, `[info][ディーラー] のターンです。\n手札を確認中...[/info]`);
    await sleep(2500);
    
    let keepIndices = getPokerBotKeepIndices(game.botHand);
    let changeIndices = [0,1,2,3,4].filter(i => !keepIndices.includes(i));
    
    if (changeIndices.length === 0) {
        await sendMessage(roomId, `/#stand`);
        await sleep(1000);
        await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    } else {
        let chgStr = changeIndices.map(i => i+1).join(' ');
        await sendMessage(roomId, `/#change ${chgStr}`);
        await sleep(1500);
        
        let newHand = [];
        for (let i=0; i<5; i++) {
            if (keepIndices.includes(i)) newHand[i] = game.botHand[i];
            else newHand[i] = game.deck.pop();
        }
        game.botHand = newHand;
        await sendMessage(roomId, `[info]🃏 [ディーラー] 新しいカードを引きました。[/info]`);
        await sleep(1500);
        await sendMessage(roomId, `/#stand`);
        await sleep(1000);
        await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    }
    
    await sleep(2000);
    await resolvePoker(roomId);
};

const proceedNextYachtTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'yacht') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        if (player.rolls === 0) {
            await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン開始[/title][piconname:${player.aid}] さんの番です！\n/#roll を入力して最初のサイコロを振ってください。\n(制限1分)[/info]`);
        } else {
            let diceStr = player.dice.map((d, i) => `[${i+1}] 🎲${d}`).join('   ');
            let ev = getYachtRank(player.dice);
            await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン継続 ( ${player.rolls}/3 回目 )[/title][piconname:${player.aid}]\nサイコロ:\n${diceStr}\n(現状の役: ${ev.name})\n\n/#change [番号] または /#stand\n例: /#change 1 3 5\n(制限1分)[/info]`);
        }
        startGameTimer(roomId, 60000); 
        return;
    }
    await proceedBotYachtTurn(roomId);
};

const proceedBotYachtTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;

    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`);
    await sleep(1500);
    await sendMessage(roomId, `/#roll`);
    await sleep(1000);
    
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [ディーラー] サイコロを振っています...[/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<4; i++) {
            await sleep(600);
            let tempD = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
            await editMessage(roomId, mId, `[info]🎲 [ディーラー] サイコロを振っています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`);
        }
        game.botDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
        await editMessage(roomId, mId, `[info]🎲 [ディーラー] サイコロを振りました。\n[ ${game.botDice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
    } else {
        game.botDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
    }
    await sleep(2000);
    
    for (let roll = 2; roll <= 3; roll++) {
        let keepIndices = getYachtBotKeepIndices(game.botDice);
        let changeIndices = [0,1,2,3,4].filter(i => !keepIndices.includes(i));
        
        if (changeIndices.length === 0) {
            await sendMessage(roomId, `/#stand`);
            await sleep(1000);
            await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
            break;
        } else {
            let chgStr = changeIndices.map(i => i+1).join(' ');
            await sendMessage(roomId, `/#change ${chgStr}`);
            await sleep(1500);
            
            let cMsgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [ディーラー] サイコロを振り直しています...[/info]`)}`);
            if (cMsgRes && cMsgRes.data) {
                let cmId = cMsgRes.data.message_id;
                for(let i=0; i<4; i++) {
                    await sleep(600);
                    let tempD = [...game.botDice];
                    changeIndices.forEach(idx => tempD[idx] = Math.floor(Math.random()*6)+1);
                    await editMessage(roomId, cmId, `[info]🎲 [ディーラー] サイコロを振り直しています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`);
                }
                changeIndices.forEach(idx => game.botDice[idx] = Math.floor(Math.random() * 6) + 1);
                await editMessage(roomId, cmId, `[info]🎲 [ディーラー] サイコロを振り直しました。(${roll}回目)\n[ ${game.botDice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
            } else {
                changeIndices.forEach(idx => game.botDice[idx] = Math.floor(Math.random() * 6) + 1);
            }
            await sleep(2000);
            
            if (roll === 3) {
                await sendMessage(roomId, `/#stand`);
                await sleep(1000);
                await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
            }
        }
    }
    await sleep(2000);
    await resolveYacht(roomId);
};

const proceedNextButaTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'buta') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let handStr = player.hand.map(c => c.suit + c.rank).join(' ');
        await sendTempMessage(roomId, `[info][title]🐷 ターン進行[/title][piconname:${player.aid}] さんの番です！\n場: ${handStr} (枚数: ${player.hand.length})\n\n/#draw (引く) または /#stand (引かない) を入力してください。\n(直前のカードと同じマークが出たらドボン！)\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await proceedBotButaTurn(roomId);
};

const proceedBotButaTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    
    let maxPlayerScore = 0;
    for (let p of game.players) {
        if (p.status !== 'bust' && p.hand.length > maxPlayerScore) maxPlayerScore = p.hand.length;
    }
    let targetScore = Math.max(2, maxPlayerScore); 

    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`);
    await sleep(2000);
    
    while (game.dealerHand.length < targetScore) {
        let hStr = game.dealerHand.map(c => c.suit + c.rank).join(' ');
        await sendMessage(roomId, `[info][ディーラー] 場: ${hStr} (枚数: ${game.dealerHand.length})[/info]`);
        await sleep(1500);
        await sendMessage(roomId, `/#draw`);
        await sleep(1000);
        
        let c = game.deck.pop(); 
        let prevCard = game.dealerHand[game.dealerHand.length - 1];
        game.dealerHand.push(c);
        
        await sendMessage(roomId, `[info]🃏 [ディーラー] 『 ${c.suit}${c.rank} 』 を引きました。[/info]`);
        await sleep(1500);

        if (c.suit === prevCard.suit) break;
    }
    
    let hStr = game.dealerHand.map(c => c.suit + c.rank).join(' ');
    let isBust = game.dealerHand.length > 1 && game.dealerHand[game.dealerHand.length - 1].suit === game.dealerHand[game.dealerHand.length - 2].suit;

    if (isBust) {
        await sendMessage(roomId, `[info][ディーラー] 場: ${hStr}\n💥 ディーラーがドボンしました！[/info]`);
    } else {
        await sendMessage(roomId, `[info][ディーラー] 場: ${hStr} (枚数: ${game.dealerHand.length})[/info]`);
        await sleep(1500);
        await sendMessage(roomId, `/#stand`);
        await sleep(1000);
        await sendMessage(roomId, `[info][ディーラー] スタンドしました。[/info]`);
    }
    await sleep(2000);
    await resolveButa(roomId);
};

const proceedBotChinchiroTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    await sendMessage(roomId, `[info][ディーラー] のターンです。[/info]`);
    await sleep(1500);
    await sendMessage(roomId, `/#roll`);
    await sleep(1000);
    
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [ディーラー] サイコロを振っています...[/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<4; i++) {
            await sleep(600);
            let tempD = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
            await editMessage(roomId, mId, `[info]🎲 [ディーラー] サイコロを振っています...\n[ ${tempD.join(', ')} ][/info]`);
        }
        game.botRoll = game.botRoll || generateChinchiroRoll();
        await editMessage(roomId, mId, `[info]🎲 [ディーラー] の出目: [ ${game.botRoll.dice.join(', ')} ] ➡ 『 ${game.botRoll.name} 』[/info]`);
    } else {
        game.botRoll = game.botRoll || generateChinchiroRoll();
    }
    await sleep(2000);
    await resolveChinchiro(roomId);
};

const proceedBotChouhan = async (roomId) => {
    let game = gameState[roomId];
    await sendMessage(roomId, `/#roll`);
    await sleep(1000);
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [ディーラー] 壺を振っています... [ ? ] [ ? ][/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<4; i++) {
            await sleep(600);
            let tempD = game.futureResult || [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
            await editMessage(roomId, mId, `[info]🎲 [ディーラー] 壺を振っています...\nｶﾗｶﾗ... [ ${tempD[0]} ] [ ${tempD[1]} ][/info]`);
        }
        await sleep(600);
        await resolveChouhan(roomId, mId);
    } else {
        await resolveChouhan(roomId);
    }
};

const proceedBotSicbo = async (roomId) => {
    let game = gameState[roomId];
    await sendMessage(roomId, `/#roll`);
    await sleep(1000);
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [ディーラー] ダイスマシン回転中... [ ? ] [ ? ] [ ? ][/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<4; i++) {
            await sleep(600);
            let tempD = game.futureResult || [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
            await editMessage(roomId, mId, `[info]🎲 [ディーラー] ダイスマシン回転中...\nｶﾗｶﾗｶﾗ... [ ${tempD[0]} ] [ ${tempD[1]} ] [ ${tempD[2]} ][/info]`);
        }
        await sleep(600);
        await resolveSicbo(roomId, mId);
    } else {
        await resolveSicbo(roomId);
    }
};

const proceedBotRoulette = async (roomId) => {
    let game = gameState[roomId];
    await sendMessage(roomId, `/#roll`);
    await sleep(1000);
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎡 [ディーラー] ルーレットを回しています... [ ?? ][/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        let resultNum = game.futureResult !== undefined ? game.futureResult : Math.floor(Math.random() * 37);
        for(let i=0; i<6; i++) {
            await sleep(600);
            let tempN = Math.floor(Math.random()*37);
            await editMessage(roomId, mId, `[info]🎡 [ディーラー] ルーレットを回しています...\nｶﾁｶﾁｶﾁ... [ ${tempN} ] (${getRouletteColorStr(tempN)})[/info]`);
        }
        await sleep(600);
        await editMessage(roomId, mId, `[info]🎡 ルーレット確定: [ ${resultNum} ] (${getRouletteColorStr(resultNum)})[/info]`);
        await sleep(2000);
        await resolveRoulette(roomId, resultNum);
    } else {
        let resultNum = game.futureResult !== undefined ? game.futureResult : Math.floor(Math.random() * 37);
        await resolveRoulette(roomId, resultNum);
    }
};

const proceedBotDerby = async (roomId) => {
    let game = gameState[roomId];
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🐎 各馬、一斉にスタートしました！[/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<3; i++) {
            await sleep(1000);
            let pos = [1,2,3,4,5,6].sort(() => Math.random() - 0.5);
            await editMessage(roomId, mId, `[info]🐎 レース中盤...\n現在の先頭は【 ${pos[0]} 】番！ 続いて【 ${pos[1]} 】番！ 追い上げる【 ${pos[2]} 】番！[/info]`);
        }
        await sleep(1000);
        await resolveDerby(roomId, mId);
    } else {
        await resolveDerby(roomId);
    }
};

const proceedBotCrash = async (roomId) => {
    let game = gameState[roomId];
    let cp = game.crashPoint;
    if (!cp) {
        cp = Math.max(1.00, (0.95 / Math.random()));
        if (cp > 100) cp = 100.0;
        game.crashPoint = cp.toFixed(2);
    }
    
    await sendMessage(roomId, `[info]🚀 ロケットが発射されました！\n倍率が上がっていきます...[/info]`);
    await sleep(1500);
    
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🚀 飛行中... [ 1.00x ][/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        let target = parseFloat(game.crashPoint);
        
        let steps = [1.2, 1.5, 2.0, 3.0, 5.0, 10.0].filter(x => x < target);
        for(let s of steps) {
            await sleep(1000);
            await editMessage(roomId, mId, `[info]🚀 飛行中... [ ${s.toFixed(2)}x ][/info]`);
        }
        await sleep(1000);
        await editMessage(roomId, mId, `[info]💥 ＢＡＡＡＮＧ！！！\n\nロケットは [ ${game.crashPoint}x ] でクラッシュしました！[/info]`);
        await sleep(2000);
        await resolveCrash(roomId, mId);
    } else {
        await resolveCrash(roomId);
    }
};

const proceedBotHighLow = async (roomId) => {
    let game = gameState[roomId];
    await sendMessage(roomId, `[info]🃏 [ディーラー] カードをドローします...[/info]`);
    await sleep(1500);
    
    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🃏 基準カード: [ ? ]\n引いたカード: [ ? ][/info]`)}`);
    if (msgRes && msgRes.data) {
        let mId = msgRes.data.message_id;
        for(let i=0; i<4; i++) {
            await sleep(600);
            let c1 = Math.floor(Math.random()*13)+1;
            let c2 = Math.floor(Math.random()*13)+1;
            await editMessage(roomId, mId, `[info]🃏 シャッフル中...\n基準カード: [ ${c1} ]\n引いたカード: [ ${c2} ][/info]`);
        }
        await sleep(600);
        await resolveHighLow(roomId, mId);
    } else {
        await resolveHighLow(roomId);
    }
};

// --- 結果精算リゾルバー ---
const processLifeBetResult = async (player, isWin, isDraw, roomId, multOverride = null) => {
    if (!player.isLifeBet) return { msg: "", profit: 0 };
    let resTxt = "";
    let betAmt = player.lifeBetBaseAmount || 1;
    let winAmt = 0;
    let resType = 'lose';
    let dealerProfit = 0;

    if (isWin) {
        let mult = multOverride || (Math.floor(Math.random() * 8) + 8); 
        winAmt = Math.floor(betAmt * mult);
        
        let stolen = await processJoker(player.aid, winAmt, roomId);
        let finalWin = winAmt - stolen;
        
        await addMoney(player.aid, finalWin);
        resTxt = `🎉 命賭け成功！！！ (全財産${mult}倍: +${formatNumber(finalWin)})`;
        resType = 'win';
        dealerProfit = -(winAmt - betAmt);
        
        await processButler(player.aid, winAmt, roomId);
    } else if (isDraw) {
        winAmt = betAmt;
        await addMoney(player.aid, winAmt);
        resTxt = `😐 引き分け (命拾い...)`;
        resType = 'draw';
        dealerProfit = 0;
    } else {
        let refunded = await processGamblerSkill(player.aid, betAmt, roomId);
        if (refunded) {
            resTxt = `💀 命賭け失敗 ➡ 🔄 逆転スキルで全額返金！(出禁回避)`;
            resType = 'draw';
            winAmt = betAmt;
            dealerProfit = 0;
        } else if (await consumeItem(player.aid, '身代わりの人形')) {
            let loseAmt = Math.floor(betAmt / 2);
            await addMoney(player.aid, betAmt - loseAmt); 
            resTxt = `💀 命賭け失敗... だが【身代わりの人形】が身代わりとなり、追放を回避！(資産半分減少)`;
            resType = 'lose';
            dealerProfit = loseAmt;
        } else {
            await supabase.from('blacklist').insert({ account_id: player.aid });
            await updateRoomMembers(roomId, [player.aid], 'readonly');
            resTxt = `💀 命賭け失敗... 永久出禁処分`;
            resType = 'lose';
            let g = gameState[roomId];
            if (g && g.type !== 'russian') {
                await processOwnerSkill(player.aid, betAmt, roomId);
                await processBounty(player.aid, betAmt, roomId);
            }
            dealerProfit = betAmt;
        }
    }
    
    await updatePlayerStats(player.aid, betAmt, winAmt, resType);
    return { msg: resTxt, profit: dealerProfit };
};

const resolveBJ = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let dScore = calculateBJScore(game.dealerHand);
    let dStr = game.dealerHand.map(c => c.suit + c.rank).join(' ');
    
    let msg = `[info][title]🃏 ブラックジャック 最終結果[/title]【 ディーラー 】\n最終手札: ${dStr} (スコア: ${dScore})\n`;
    if (dScore > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let pScore = calculateBJScore(player.hand);
        let winAmt = 0; let resTxt = "";
        let isWin=false, isDraw=false, isLose=false;
        let isBJ = false;

        if (player.status === 'bust') { 
            isLose = true;
        } else if (player.status === 'bj') {
            if (dScore === 21 && game.dealerHand.length === 2) isDraw = true;
            else { isWin = true; isBJ = true; }
        } else {
            if (dScore > 21 || pScore > dScore) isWin = true;
            else if (pScore === dScore) isDraw = true;
            else isLose = true;
        }

        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) {
                let mult = isBJ ? 2.5 : 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                resTxt += isBJ ? `(cracker) 勝利！ (BJ: 配当2.5倍) (+${formatNumber(finalWin)})` : `(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 負け (没収)`;
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);
        
        msg += `[piconname:${player.aid}]: スコア ${pScore} ➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolvePoker = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let botEv = getPokerRank(game.botHand);
    let botStr = game.botHand.map(c => c.suit + c.rank).join(' ');
    let msg = `[info][title]🃏 ポーカー 最終結果[/title]【 ディーラー 】\n確定手札: ${botStr} (${botEv.name})\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let pEv = getPokerRank(player.hand);
        let pStr = player.hand.map(c => c.suit + c.rank).join(' ');
        let comp = comparePoker(pEv, botEv);
        let isWin = comp > 0, isDraw = comp === 0, isLose = comp < 0;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let mult = 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                resTxt += `(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: ${pStr} (${pEv.name})\n➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveYacht = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let botEv = getYachtRank(game.botDice);
    let botStr = game.botDice.map(d => `🎲${d}`).join('');
    let msg = `[info][title]🎲 ヨット 最終結果[/title]【 ディーラー 】\n確定サイコロ: [${botStr}] (${botEv.name})\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let pEv = getYachtRank(player.dice);
        let pStr = player.dice.map(d => `🎲${d}`).join('');
        let comp = compareYacht(pEv, botEv);
        let isWin = comp > 0, isDraw = comp === 0, isLose = comp < 0;
        
        if (pEv.name === "役なし") {
            isLose = true; isWin = false; isDraw = false;
        }

        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let mult = 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                resTxt += `(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: [${pStr}] (${pEv.name})\n➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveButa = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let dHand = game.dealerHand;
    let isDBust = dHand.length > 1 && dHand[dHand.length - 1].suit === dHand[dHand.length - 2].suit;
    let dScore = isDBust ? 0 : dHand.length;
    let dStr = dHand.map(c => c.suit + c.rank).join(' ');
    
    let msg = `[info][title]🐷 豚のしっぽ 最終結果[/title]【 ディーラー 】\n最終の場: ${dStr}\n`;
    if (isDBust) msg += `💥 ディーラー ドボン！\n`;
    else msg += `確定枚数: ${dScore}\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isPBust = player.status === 'bust';
        let pScore = isPBust ? 0 : player.hand.length;
        let isWin=false, isDraw=false, isLose=false;
        let resTxt = "";
        
        if (isPBust) isLose = true;
        else {
            if (isDBust || pScore > dScore) isWin = true;
            else if (pScore === dScore) isDraw = true;
            else isLose = true;
        }

        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) {
                let mult = 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult); 
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                resTxt += `🎉 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 負け (ドボン・没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            } 
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 枚数 ${pScore} ➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveChinchiro = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let parentRoll = game.botRoll; 
    let msg = `[info][title]🎲 チンチロリン 最終結果[/title]【 ディーラー(親) の出目 】\n[ ${parentRoll.dice.join(', ')} ] ➡ 『 ${parentRoll.name} 』\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let r = player.res || { rank: 1, name: "欠席", mult: 1, score: 0, dice: [0,0,0] };
        let isWin = (r.rank > parentRoll.rank) || (r.rank === parentRoll.rank && r.score > parentRoll.score);
        let isDraw = (r.rank === parentRoll.rank && r.score === parentRoll.score);
        let isLose = !isWin && !isDraw;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
                totalDealerProfit += 0;
            } else if (isWin) { 
                let mult = r.mult > 0 ? r.mult : 1;
                mult += 1; // 賭け金返還込み
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                
                let winAmt = Math.floor(player.bet * mult);
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 勝ち！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ ${resTxt}\n`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveChouhan = async (roomId, mId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let d1, d2;
    if (game.futureResult) { d1 = game.futureResult[0]; d2 = game.futureResult[1]; }
    else { d1 = Math.floor(Math.random() * 6) + 1; d2 = Math.floor(Math.random() * 6) + 1; }
    let sum = d1 + d2;
    let result = (sum % 2 === 0) ? 'chou' : 'han';
    
    if(mId) await editMessage(roomId, mId, `[info]🎲 [ディーラー] 壺を開けました。\n[ ${d1} ] [ ${d2} ][/info]`);
    await sleep(1000);
    
    let msg = `[info][title]🎲 丁半 最終結果[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isWin = player.choice === result;
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }
        
        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let mult = 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 的中！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 予想[${player.choice === 'chou' ? '丁' : '半'}] ➡ ${resTxt}\n`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveSicbo = async (roomId, mId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let d1, d2, d3;
    if (game.futureResult) { d1 = game.futureResult[0]; d2 = game.futureResult[1]; d3 = game.futureResult[2]; }
    else { d1 = Math.floor(Math.random() * 6) + 1; d2 = Math.floor(Math.random() * 6) + 1; d3 = Math.floor(Math.random() * 6) + 1; }
    let sum = d1 + d2 + d3;
    let isTriple = d1 === d2 && d2 === d3;
    
    let resultType = isTriple ? "any" : (sum >= 11 && sum <= 17 ? "dai" : "shou");
    let resultName = isTriple ? "ゾロ目" : (resultType === "dai" ? "大" : "小");
    
    if(mId) await editMessage(roomId, mId, `[info]🎲 [ディーラー] ダイス確定:\n[ ${d1} ] [ ${d2} ] [ ${d3} ][/info]`);
    await sleep(1000);
    
    let msg = `[info][title]🎲 シックボー(大小) 最終結果[/title]出目合計: ${sum}\n➡ 『 ${resultName} 』\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isWin = false;
        let mult = 0;
        if (player.choice === 'any' && isTriple) { isWin = true; mult = 15; }
        else if ((player.choice === 'dai' || player.choice === 'shou') && player.choice === resultType && !isTriple) { isWin = true; mult = 1.8; }
        
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        let choiceName = player.choice === 'any' ? "ゾロ目" : (player.choice === 'dai' ? "大" : "小");
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, mult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) {
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin);
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 的中！ (${mult}倍) (+${formatNumber(finalWin)})`;
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 はずれ (没収)`;
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 予想[${choiceName}] ➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveRoulette = async (roomId, resultNum) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let msg = `[info][title]🎡 ルーレット 最終結果[/title]🎯 当たり番号: 【 ${resultNum} 】 (${getRouletteColorStr(resultNum)})\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isWin = isRouletteWin(player.choice, resultNum);
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let mult = getRouletteMult(player.choice);
            const { data: pD } = await supabase.from('players').select('job').eq('account_id', player.aid).single();
            if (mult === 2 && pD && pD.job === '数学者') mult = 2.1;
            
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, mult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let mult = getRouletteMult(player.choice);
                const { data: pD } = await supabase.from('players').select('job').eq('account_id', player.aid).single();
                if (mult === 2 && pD && pD.job === '数学者') mult = 2.1;
                
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 的中！ (${mult}倍) (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 予想[${player.choice}] ➡ ${resTxt}\n`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveDerby = async (roomId, mId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId); 
    if (game.remindId) clearTimeout(game.remindId);
    
    let winCombo = game.futureResult;
    if (!winCombo) {
        let stats = game.stats, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
        let r1 = Math.random() * totalW, s1 = 0, first = 1;
        for (let i=0; i<6; i++) { s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
        ws[first-1] = 0; 
        totalW = ws.reduce((a, b) => a + b, 0);
        let r2 = Math.random() * totalW, s2 = 0, second = 1;
        for (let i=0; i<6; i++) { s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
        winCombo = first < second ? `${first}-${second}` : `${second}-${first}`;
    }
    let [first, second] = winCombo.split('-');
    let odd = game.oddsMap[winCombo];
    
    if(mId) await editMessage(roomId, mId, `[info]🐎 先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)[/info]`);
    await sleep(1500);
    
    let msg = `[info][title]🐎 ダービー 最終結果[/title]🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isWin = player.choice === winCombo;
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, odd);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)\n`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let mult = odd;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult); 
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 的中！ (+${formatNumber(finalWin)} コイン)\n`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 はずれ ➡ 🔄 逆転スキルで返金\n`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 はずれ (没収)\n`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 予想[${player.choice}] ➡ ${resTxt}`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveCrash = async (roomId, mId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let cp = parseFloat(game.crashPoint);
    let msg = `[info][title]🚀 クラッシュ 最終結果[/title]💥 クラッシュ倍率: 【 ${game.crashPoint}x 】\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let targetMult = parseFloat(player.choice) || 1.01;
        let isWin = targetMult <= cp;
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, targetMult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)\n`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let mult = targetMult;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 利確成功！ (${mult}x) (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 クラッシュ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 クラッシュ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 目標[${targetMult}x] ➡ ${resTxt}\n`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveHighLow = async (roomId, mId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let c1, c2;
    if (game.futureResult) { c1 = game.futureResult[0]; c2 = game.futureResult[1]; }
    else { c1 = Math.floor(Math.random() * 13) + 1; c2 = Math.floor(Math.random() * 13) + 1; }
    
    let result = 'draw';
    if (c2 > c1) result = 'high';
    else if (c2 < c1) result = 'low';
    
    let rStr = result === 'draw' ? 'Draw (引き分け)' : (result === 'high' ? 'High (高い)' : 'Low (低い)');

    if(mId) await editMessage(roomId, mId, `[info]🃏 カード確定！\n基準カード: [ ${c1} ]\n引いたカード: [ ${c2} ][/info]`);
    await sleep(1000);
    
    let msg = `[info][title]🃏 ハイロー 最終結果[/title]基準: ${c1} ➡ 引いた数: ${c2}\n結果: 『 ${rStr} 』\n[hr]【 プレイヤー結果 】\n`;

    let totalDealerProfit = 0;

    for (let player of game.players) {
        let isWin = false, isDraw = false, isLose = false;
        if (result === 'draw') isDraw = true;
        else if (player.choice === result) isWin = true;
        else isLose = true;

        let resTxt = "";
        
        if (isLose && await consumeItem(player.aid, 'ディーラーの弱み')) {
            isLose = false; isDraw = true; isWin = false;
            resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
        }

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            if (isDraw) {
                if(!resTxt) resTxt = `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let mult = 2;
                if (await consumeItem(player.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                let winAmt = Math.floor(player.bet * mult);
                
                let stolen = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `(cracker) 的中！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    await processBounty(player.aid, player.bet, roomId);
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType);
        }
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (!isDraw && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 予想[${player.choice}] ➡ ${resTxt}\n`; 
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveDaifugo = async (roomId) => {
    let g = gameState[roomId];
    if (!g) return;
    clearTimeout(g.timeoutId);
    
    let lastP = g.players.find(x => x.status === 'playing');
    if (lastP) g.daifugo.rankings.push(lastP);

    for (let p of g.players) {
        if (p.pRoomId) await deleteDaifugoRoom(p.pRoomId);
    }

    let msg = `[info][title]👑 大富豪 最終結果[/title]`;
    let ranks = ["大富豪", "富豪", "平民", "貧民", "大貧民"];
    let mults = [3.0, 1.5, 0, 0, 0]; 
    
    let totalDealerProfit = 0;

    for (let i=0; i<g.daifugo.rankings.length; i++) {
        let p = g.daifugo.rankings[i];
        let rName = ranks[i] || "平民";
        let defaultMult = mults[i] || 0;
        
        let resTxt = "";
        if (p.aid !== 'bot') {
            let isWin = defaultMult > 0;
            let isLose = !isWin;
            let isDraw = false;
            
            if (isLose && await consumeItem(p.aid, 'ディーラーの弱み')) {
                isLose = false; isDraw = true; isWin = false;
                resTxt += `😱 【ディーラーの弱み】で負けを無効化し引き分けにしました！\n`;
            }

            if (p.isLifeBet) {
                let lbRes = await processLifeBetResult(p, isWin, isDraw, roomId, defaultMult);
                resTxt += lbRes.msg;
                totalDealerProfit += lbRes.profit;
            } else {
                let winAmtForStats = 0; let resType = 'lose';
                if (isDraw) {
                    if(!resTxt) resTxt = `😐 引き分け (返金)\n`; 
                    await addMoney(p.aid, p.bet); 
                    winAmtForStats = p.bet; resType = 'draw';
                } else if (isWin) {
                    let mult = defaultMult;
                    if (await consumeItem(p.aid, 'ダブルアップ・コイン')) { mult *= 2; resTxt += `🪙 ダブルアップ！ `; }
                    let winAmt = Math.floor(p.bet * mult);
                    
                    let stolen = await processJoker(p.aid, winAmt, roomId);
                    let finalWin = winAmt - stolen;
                    
                    await addMoney(p.aid, finalWin);
                    winAmtForStats = winAmt; resType = 'win';
                    resTxt += `(cracker) ${rName}！ (${mult}倍) (+${formatNumber(finalWin)})`;
                    totalDealerProfit -= (winAmt - p.bet);
                    
                    await processButler(p.aid, winAmt, roomId);
                } else {
                    let refunded = await processGamblerSkill(p.aid, p.bet, roomId);
                    if (refunded) {
                        resTxt += `💀 ${rName} ➡ 🔄 逆転スキルで返金`;
                        winAmtForStats = p.bet; resType = 'draw';
                    } else {
                        resTxt += `💀 ${rName}... (没収)`;
                        await processOwnerSkill(p.aid, p.bet, roomId);
                        await processBounty(p.aid, p.bet, roomId);
                        totalDealerProfit += p.bet;
                    }
                }
                await updatePlayerStats(p.aid, p.bet, winAmtForStats, resType);
            }
            if (isWin) await updateWinStreak(p.aid, 'win', roomId);
            else if (isLose && !resTxt.includes('返金')) await updateWinStreak(p.aid, 'lose', roomId);
            msg += `${i+1}位: [piconname:${p.aid}] ➡ ${resTxt}\n`;
        } else {
            msg += `${i+1}位: 🤖 ディーラー (${rName})\n`;
        }
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

// --- Webhook Endpoint ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id;
    lastActiveRoomId = roomId; 
    const body = ev.body || "";
    const senderId = ev.account_id.toString();
    const msgId = ev.message_id;
    const today = getTodayStr();

    (async () => {
        try {
            if (daifugoRooms[roomId]) {
                const { mainRoomId, aid } = daifugoRooms[roomId];
                if (senderId !== aid && senderId !== BOT_ACCOUNT_ID) return;
                if (body.match(/^[/#]pass(\s|$)/) || body.match(/^[/#]play(\s|$)/)) {
                    handleDaifugoAction(mainRoomId, aid, body.trim());
                }
                return;
            }

            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { 
                await updateRoomMembers(roomId, [senderId], 'readonly'); 
                return; 
            }

            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            let rankCmd = body.trim().match(/^[/#](winner-rank|rtp-rank|winrate-rank|worst-rank|daily-rank)$/);
            if (rankCmd) {
                let cmdType = rankCmd[1];
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !eI.includes(d.account_id) && (d.plays || 0) >= 10) : [];
                
                let title = "", s = "";
                if (cmdType === 'winner-rank') {
                    title = "🏆 勝利数ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => (b.wins||0) - (a.wins||0));
                    s = f.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let lastLoginStr = d.last_daily_date ? (d.last_daily_date === today ? "本日" : `${getDiffDays(d.last_daily_date, today)}日前`) : "未ログイン";
                        return `${md} ${i+1}位: [piconname:${d.account_id}] (最終: ${lastLoginStr})\n　🏆 勝利数: ${d.wins||0}回 (勝率: ${d.plays ? ((d.wins||0)/(d.plays)*100).toFixed(1) : 0}%)`;
                    }).join('\n[hr]');
                } else if (cmdType === 'rtp-rank') {
                    title = "💹 RTP(回収率)ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => ((b.total_bet||0)>0 ? (b.total_return||0)/(b.total_bet) : 0) - ((a.total_bet||0)>0 ? (a.total_return||0)/(a.total_bet) : 0));
                    s = f.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let rtp = (d.total_bet||0)>0 ? ((d.total_return||0)/(d.total_bet)*100).toFixed(1) : 0;
                        let lastLoginStr = d.last_daily_date ? (d.last_daily_date === today ? "本日" : `${getDiffDays(d.last_daily_date, today)}日前`) : "未ログイン";
                        return `${md} ${i+1}位: [piconname:${d.account_id}] (最終: ${lastLoginStr})\n　💹 RTP: ${rtp}% (総獲得: ${formatNumber(d.total_return||0)})`;
                    }).join('\n[hr]');
                } else if (cmdType === 'winrate-rank') {
                    title = "📈 勝率ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => ((b.plays||0)>0 ? (b.wins||0)/(b.plays) : 0) - ((a.plays||0)>0 ? (a.wins||0)/(a.plays) : 0));
                    s = f.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let wr = (d.plays||0)>0 ? ((d.wins||0)/(d.plays)*100).toFixed(1) : 0;
                        let lastLoginStr = d.last_daily_date ? (d.last_daily_date === today ? "本日" : `${getDiffDays(d.last_daily_date, today)}日前`) : "未ログイン";
                        return `${md} ${i+1}位: [piconname:${d.account_id}] (最終: ${lastLoginStr})\n　📈 勝率: ${wr}% (${d.wins||0}勝 / ${d.plays||0}戦)`;
                    }).join('\n[hr]');
                } else if (cmdType === 'worst-rank') {
                    title = "💸 ワーストランキング TOP10 (直近3日以内)";
                    let activePlayers = (ls || []).filter(d => !eI.includes(d.account_id) && d.last_daily_date && getDiffDays(d.last_daily_date, today) <= 3);
                    activePlayers.sort((a,b) => calculateNetWorth(a) - calculateNetWorth(b));
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "😭" : (i===1 ? "😰" : (i===2 ? "😨" : "📉")); 
                        let net = calculateNetWorth(d);
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💸 純資産: ${formatNumber(net)} コイン`;
                    }).join('\n[hr]');
                    if (!s) s = "条件を満たすプレイヤーがいません。";
                } else if (cmdType === 'daily-rank') {
                    title = "🔥 本日の獲得額ランキング TOP10";
                    let activePlayers = (ls || []).filter(d => !eI.includes(d.account_id) && d.last_daily_date === today && d.daily_start_networth != null);
                    activePlayers.sort((a,b) => (calculateNetWorth(b) - b.daily_start_networth) - (calculateNetWorth(a) - a.daily_start_networth));
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let profit = calculateNetWorth(d) - d.daily_start_networth;
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　📈 本日の利益: ${formatNumber(profit)} コイン`;
                    }).join('\n[hr]');
                    if (!s) s = "条件を満たすプレイヤーがいません。";
                }
                return sendTempMessage(roomId, `[info][title]${title}[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, work_limit: 10, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                }
            }

            let { data: player } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (!player) {
                player = { account_id: senderId, money: 0, bank: 0, debt: 0, last_interest_time: Date.now(), slot_count: 0, work_limit: 10, msg_count: 1, job: 'サラリーマン', daily_give_amount: 0, last_give_date: today, win_streak: 0, life_bet_unlocked: false, kabu_owned: 0, plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0, russian_trauma_time: 0, last_daily_date: null, stocks: '{}', login_streak: 0, daily_start_networth: 0, items: '{}', job_state: '{}' };
                await supabase.from('players').insert(player);
                player.items = {}; player.job_state = {};
            } else {
                if (typeof player.items === 'string') player.items = JSON.parse(player.items || '{}');
                if (typeof player.job_state === 'string') player.job_state = JSON.parse(player.job_state || '{}');
                if (gambleActive && !body.match(/^[/#]/)) {
                    let mc = (player.msg_count || 0) + 1; 
                    player.msg_count = mc;
                    await supabase.from('players').update({ msg_count: mc }).eq('account_id', senderId);
                }
            }

            if (player && player.last_daily_date !== today) {
                let diff = getDiffDays(player.last_daily_date, today);
                let streak = player.login_streak || 0;
                if (diff === 1) streak++;
                else streak = 1;

                let dailyBonus = streak * 1000;
                if (dailyBonus > 10000) dailyBonus = 10000; 

                player.money = (player.money || 0) + dailyBonus;
                player.login_streak = streak;
                
                let jobMsg = "";
                let catBonus = 0;
                if (player.items && player.items['黄金の招き猫'] > 0 && player.bank > 0) {
                    catBonus = Math.floor(player.bank * 0.005);
                    player.bank += catBonus;
                    jobMsg += `\n😸 [黄金の招き猫] 効果: 預金に利息(+0.5%)がつき、${formatNumber(catBonus)} コイン増えました！`;
                }

                if (player.job === '銀行員' && player.bank > 0) {
                    let interest = Math.floor(player.bank * 0.01);
                    player.bank += interest;
                    jobMsg += `\n🏦 [銀行員] 特権: 預金に利息(1%)がつき、${formatNumber(interest)} コイン増えました！`;
                }
                
                if (player.job === '賭博師' && player.skill_date !== today) {
                    let addCount = Math.floor(Math.random() * 6) + 5;
                    player.slot_count = (player.slot_count || 0) - addCount;
                    player.skill_date = today;
                    jobMsg += `\n🎰 [賭博師] 特権: スロット回数が ${addCount} 回追加されました！`;
                }

                let startNet = calculateNetWorth(player);
                player.daily_start_networth = startNet;
                player.last_daily_date = today;

                await supabase.from('players').update({ 
                    money: player.money, 
                    bank: player.bank,
                    last_daily_date: today, 
                    login_streak: streak,
                    daily_start_networth: startNet,
                    slot_count: player.slot_count, 
                    skill_date: player.skill_date 
                }).eq('account_id', senderId);
                
                await sendTempMessage(roomId, `[info]🎁 デイリーボーナス！ (${streak}日連続ログイン)\n[piconname:${senderId}] 本日最初のアクションです。\n連続ログインボーナス ${formatNumber(dailyBonus)} コインを獲得！${jobMsg}[/info]`);
            }

            let myMoney = player ? player.money : 0;
            let myBank = player ? player.bank : 0;
            let myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';

            // トラウマチェック
            const isGameCmd = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian|crash|highlow)\b/);
            const isJoinCmd = body.match(/(^|\n)[/#]join\b/);
            const isBetCmd = body.match(/(^|\n)[/#]bet\s+(max|half|life|[0-9.]+)/);
            if ((isGameCmd || isJoinCmd || isBetCmd) && gambleActive) {
                let remTrauma = checkTrauma(player);
                if (remTrauma > 0) {
                    return sendTempMessage(roomId, `[info]⚠️ [piconname:${senderId}]\nロシアンルーレットの恐怖で手が震え、ゲームに参加できない…\n(残り ${remTrauma} 秒)[/info]`);
                }
            }

            // --- スクラッチくじ ---
            if (/(^|\n)[/#]scratch\s+([0-9]+)/.test(body) && gambleActive) {
                let amt = parseInt(body.match(/(^|\n)[/#]scratch\s+([0-9]+)/)[2], 10);
                if (myMoney < amt) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！[/info]`);
                
                myMoney -= amt;
                let symbols = ['🍒', '🔔', '🍉', '⭐', '💎', '7️⃣'];
                let mults = { '🍒': 2, '🔔': 5, '🍉': 10, '⭐': 20, '💎': 30, '7️⃣': 50 };
                let resS = [
                    symbols[Math.floor(Math.random()*symbols.length)],
                    symbols[Math.floor(Math.random()*symbols.length)],
                    symbols[Math.floor(Math.random()*symbols.length)]
                ];
                let isWin = resS[0] === resS[1] && resS[1] === resS[2];
                
                let winAmt = 0;
                let msg = `[info][title]🎫 スクラッチくじ[/title]削っています...\n\n[ ${resS.join(' | ')} ]\n\n`;
                if (isWin) {
                    let mult = mults[resS[0]];
                    winAmt = amt * mult;
                    let stolen = await processJoker(senderId, winAmt, roomId);
                    let finalWin = winAmt - stolen;
                    msg += `🎉 絵柄が揃いました！ ${mult}倍の大当たり！ (+${formatNumber(finalWin)} コイン)`;
                    myMoney += finalWin;
                    await updatePlayerStats(senderId, amt, winAmt, 'win');
                    await processButler(senderId, winAmt, roomId);
                } else {
                    msg += `💀 ハズレ...`;
                    await updatePlayerStats(senderId, amt, 0, 'lose');
                    await processBounty(senderId, amt, roomId);
                }
                
                await supabase.from('players').update({ money: myMoney }).eq('account_id', senderId);
                return sendMessage(roomId, msg + "[/info]");
            }

            // --- アイテムショップ関連 ---
            if (/(^|\n)[/#]shop\b/.test(body)) {
                let msg = `[info][title]🏪 通常ショップ[/title]
以下のアイテムを /#buy [アイテム名] で購入できます。
・ディーラーの弱み (500万): 負けを無効化し引き分け(返金)にする
・ジョーカーの招待状 (30万): /#joker [aid] で指定。相手が次に勝った際、配当の10〜20%を横取りする
・ダブルアップ・コイン (10万): 次に勝った時の配当をさらに2倍にする
・ハズレ札の押し付け (50万): BJ/ポーカー/豚のしっぽ進行中、自分のターンに /#push で最弱カードを引き直す[/info]`;
                return sendTempMessage(roomId, msg);
            }

            if (/(^|\n)[/#]blackmarket\b/.test(body)) {
                if (Math.random() < 0.05) {
                    let msg = `[info][title]🕶️ 闇市[/title]
ヒッヒッヒ...よくここが見つかったな。 /#buy [アイテム名] で買えるぞ。
・黄金の招き猫 (100万): 預金利息がさらに+0.5%加算
・身代わりの人形 (200万): life bet失敗時、1回だけ追放を回避し資産半分を守る
・デス・リバース (30万): ロシアンルーレットで撃たれた際、死を反転させて相手を道連れにする[/info]`;
                    return sendTempMessage(roomId, msg);
                } else {
                    return sendTempMessage(roomId, `[info]路地裏を探したが、怪しい店は見つからなかった...[/info]`);
                }
            }

            const buyMatch = body.match(/(^|\n)[/#]buy\s+(.+)/);
            if (buyMatch && gambleActive) {
                let itemName = buyMatch[2].trim();
                let prices = {
                    'ディーラーの弱み': 5000000,
                    'ジョーカーの招待状': 300000,
                    'ダブルアップ・コイン': 100000,
                    'ハズレ札の押し付け': 500000,
                    '黄金の招き猫': 1000000,
                    '身代わりの人形': 2000000,
                    'デス・リバース': 300000
                };
                let cost = prices[itemName];
                if (!cost) return sendTempMessage(roomId, `[info]⚠️ そのアイテムは存在しません。[/info]`);
                if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません。(必要: ${formatNumber(cost)} コイン)[/info]`);
                
                player.items[itemName] = (player.items[itemName] || 0) + 1;
                await supabase.from('players').update({ money: myMoney - cost, items: JSON.stringify(player.items) }).eq('account_id', senderId);
                
                return sendTempMessage(roomId, `[info]🛍️ 【${itemName}】を購入しました！ (-${formatNumber(cost)} コイン)[/info]`);
            }

            if (/(^|\n)[/#]bounty\b/.test(body)) {
                if (myJob !== '賞金稼ぎ') return sendTempMessage(roomId, `[info]⚠️ 賞金稼ぎ専用コマンドです。[/info]`);
                let target = repliedAid || (body.match(/(^|\n)[/#]bounty\s+([0-9]+)/)||[])[2];
                if (!target) return sendTempMessage(roomId, `[info]⚠️ ターゲットを指定してください。[/info]`);
                player.job_state.bounty_target = target;
                await supabase.from('players').update({ job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info]🎯 ターゲットを [piconname:${target}] に設定しました。次に敗北した際、没収額の10%を奪います。[/info]`);
            }

            if (/(^|\n)[/#]joker\b/.test(body)) {
                let target = repliedAid || (body.match(/(^|\n)[/#]joker\s+([0-9]+)/)||[])[2];
                if (!target) return sendTempMessage(roomId, `[info]⚠️ ターゲットを指定してください。[/info]`);
                if ((player.items['ジョーカーの招待状'] || 0) > 0) {
                    player.items['ジョーカーの招待状']--;
                    player.job_state.joker_target = target;
                    await supabase.from('players').update({ items: JSON.stringify(player.items), job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info]🃏 【ジョーカーの招待状】を使用しました！\nターゲット: [piconname:${target}]\n相手が次に勝利した際、配当を横取りします。[/info]`);
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ ジョーカーの招待状を持っていません！[/info]`);
                }
            }

            if (/(^|\n)[/#]push\b/.test(body) && gambleActive && gameState[roomId] && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing' && player.items['ハズレ札の押し付け'] > 0) {
                    if (g.type === 'poker' || g.type === 'bj' || g.type === 'buta') {
                        player.items['ハズレ札の押し付け']--;
                        await supabase.from('players').update({ items: JSON.stringify(player.items) }).eq('account_id', senderId);
                        
                        let weakIdx = 0; let weakVal = 999;
                        pl.hand.forEach((c, idx) => {
                            let v = c.rank === 'A' ? 14 : (['J','Q','K'].includes(c.rank) ? [11,12,13][['J','Q','K'].indexOf(c.rank)] : parseInt(c.rank));
                            if (v < weakVal) { weakVal = v; weakIdx = idx; }
                        });
                        
                        let oldCard = pl.hand[weakIdx];
                        let newCard = g.deck.pop();
                        pl.hand[weakIdx] = newCard;
                        
                        let handStr = pl.hand.map(c => c.suit + c.rank).join(' ');
                        await sendTempMessage(roomId, `[info]🃏 【ハズレ札の押し付け】発動！\n最弱のカード(${oldCard.suit}${oldCard.rank})を捨てて引き直しました。\n現在: ${handStr}[/info]`);
                        return;
                    }
                }
            }

            // --- 隠しコマンド（株価強制リセット） ---
            if (/(^|\n)[/#]kabu-set\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                let match = body.match(/(^|\n)[/#]kabu-set\s+([0-9]+)/);
                if (match) {
                    kabuData.price = parseInt(match[2], 10);
                    kabuData.pendingProfit = 0;
                    kabuData.history.push(kabuData.price);
                    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                    return sendTempMessage(roomId, `[info][title]📈 株価強制設定[/title]管理者がカジノ株の株価を ${formatNumber(kabuData.price)} コインに設定しました。[/info]`);
                }
            }

            // --- おみくじ機能 ---
            if (/(^|\n)[/#]omikuji\b/.test(body) && gambleActive) {
                if (player.omikuji_date === today) {
                    return sendTempMessage(roomId, `[info]⛩️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n結果: 【 ${player.omikuji_result || '不明'} 】\n(明日また引いてください)[/info]`);
                }
                const r = Math.random();
                let resS = '吉';
                if (r < 0.1) resS = '大吉';
                else if (r < 0.3) resS = '中吉';
                else if (r < 0.6) resS = '吉';
                else if (r < 0.8) resS = '小吉';
                else if (r < 0.95) resS = '末吉';
                else if (r < 0.98) resS = '凶';
                else resS = '大凶';

                await supabase.from('players').update({ omikuji_date: today, omikuji_result: resS }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]⛩️ おみくじ結果[/title][piconname:${senderId}]\nガシャガシャ... ポロッ\n\nあなたの今日の運勢は【 ${resS} 】です！\n(スロットの確率に影響します)[/info]`);
            }

            // --- 未来視機能 ---
            if (/(^|\n)[/#]next-future\b/.test(body) && gambleActive) {
                if (myJob !== '未来人') return sendTempMessage(roomId, `[info]⚠️ 未来人専用のコマンドです。[/info]`);
                let g = gameState[roomId];
                if (!g || g.state === 'IDLE') return sendTempMessage(roomId, `[info]⚠️ 現在進行中のゲームはありません。[/info]`);
                if (g.state === 'RECRUITING') return sendTempMessage(roomId, `[info]⚠️ ゲームが開始されていません。[/info]`);
                if (g.type === 'derby') return sendTempMessage(roomId, `[info]⚠️ 競馬の未来は不確定要素が多すぎて視えません。[/info]`);
                
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 未来視の能力は1日1回までです。[/info]`);
                
                let isTrue = Math.random() < 0.7; // 70%の確率で正解
                let futureMsg = "";

                if (['bj', 'buta', 'poker', 'daifugo'].includes(g.type)) {
                    if (g.state === 'ACTION' && g.deck && g.deck.length > 0) {
                        let card = g.deck[g.deck.length - 1];
                        if (!isTrue) {
                            const suits = ['♠', '♥', '♣', '♦'], ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
                            let fc;
                            do { fc = { suit: suits[Math.floor(Math.random()*4)], rank: ranks[Math.floor(Math.random()*13)] }; } while (fc.suit === card.suit && fc.rank === card.rank);
                            card = fc;
                        }
                        futureMsg = `次に出るカードは【 ${card.suit}${card.rank} 】のようです...`;
                    } else {
                        return sendTempMessage(roomId, `[info]⚠️ 今は未来を視るタイミングではありません。[/info]`);
                    }
                } else if (g.type === 'rolet') {
                    if (g.state === 'BETTING') {
                        if (g.futureResult === undefined) g.futureResult = Math.floor(Math.random() * 37);
                        let realColor = getRouletteColorStr(g.futureResult).replace(/[^🔴⚫🟢赤黒緑]/g, ''); 
                        if (!isTrue) {
                            let colors = ["🔴赤", "⚫黒", "🟢緑"];
                            colors = colors.filter(c => c !== realColor);
                            realColor = colors[Math.floor(Math.random()*colors.length)];
                        }
                        futureMsg = `次のルーレットの色は【 ${realColor} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'sicbo') {
                    if (g.state === 'BETTING') {
                        if (!g.futureResult) g.futureResult = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                        let dice = g.futureResult;
                        if (!isTrue) {
                            let falseDice;
                            do { falseDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1]; } while(falseDice.join(',') === dice.join(','));
                            dice = falseDice;
                        }
                        futureMsg = `次のダイスは【 ${dice.join(', ')} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'chouhan') {
                    if (g.state === 'BETTING') {
                        if (!g.futureResult) g.futureResult = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                        let dice = g.futureResult;
                        if (!isTrue) {
                            let falseDice;
                            do { falseDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1]; } while(falseDice.join(',') === dice.join(','));
                            dice = falseDice;
                        }
                        futureMsg = `次の壺の中身は【 ${dice[0]} と ${dice[1]} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'cc') {
                    if (g.state === 'BETTING') {
                        if (!g.botRoll) g.botRoll = generateChinchiroRoll();
                        let d = g.botRoll.dice;
                        if (!isTrue) {
                            let falseDice;
                            do { falseDice = generateChinchiroRoll().dice; } while(falseDice.join(',') === d.join(','));
                            d = falseDice;
                        }
                        futureMsg = `親(ディーラー)の出目は【 ${d.join(', ')} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'crash') {
                    if (g.state === 'BETTING') {
                        if (!g.crashPoint) {
                            let cp = Math.max(1.00, (0.95 / Math.random()));
                            if (cp > 100) cp = 100.0;
                            g.crashPoint = cp.toFixed(2);
                        }
                        let cp = g.crashPoint;
                        if (!isTrue) {
                            let falseCp;
                            do { falseCp = Math.max(1.00, (0.95 / Math.random())).toFixed(2); } while(falseCp === cp);
                            cp = falseCp;
                        }
                        futureMsg = `次発射されるロケットは【 ${cp}x 】付近でクラッシュするようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'highlow') {
                    if (g.state === 'BETTING') {
                        if (!g.futureResult) g.futureResult = [Math.floor(Math.random()*13)+1, Math.floor(Math.random()*13)+1];
                        let res = g.futureResult[1] > g.futureResult[0] ? 'High' : (g.futureResult[1] < g.futureResult[0] ? 'Low' : 'Draw');
                        if (!isTrue) {
                            let opts = ['High', 'Low', 'Draw'].filter(x => x !== res);
                            res = opts[Math.floor(Math.random()*opts.length)];
                        }
                        futureMsg = `次は【 ${res} 】になるようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'yacht') {
                    if (g.state === 'ACTION') {
                        let pl = g.players[g.turnIndex];
                        if (pl && pl.aid === senderId) {
                            if (!pl.futureDice) pl.futureDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
                            let d = pl.futureDice;
                            if (!isTrue) {
                                let falseDice;
                                do { falseDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); } while(falseDice.join(',') === d.join(','));
                                d = falseDice;
                            }
                            futureMsg = `あなたが次に振るダイスは【 ${d.join(', ')} 】のようです...`;
                        } else return sendTempMessage(roomId, `[info]⚠️ 自分のターンで使用してください。[/info]`);
                    } else return sendTempMessage(roomId, `[info]⚠️ アクション中に使用してください。[/info]`);
                } else if (g.type === 'russian') {
                    if (g.state === 'ACTION') {
                        let dist = (g.bulletPos - g.currentChamber + 6) % 6;
                        if (!isTrue) {
                            let falseDist;
                            do { falseDist = Math.floor(Math.random() * 6); } while (falseDist === dist);
                            dist = falseDist;
                        }
                        if (dist === 0) futureMsg = `次引き金を引くと【 弾が出る 】ようです...`;
                        else futureMsg = `あと【 ${dist} 回 】は空砲のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ アクション中に使用してください。[/info]`);
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ このゲームでは未来視できません。[/info]`);
                }

                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]👁️ 未来視[/title][piconname:${senderId}]\n頭の中に未来のビジョンが流れ込んできた...！\n\n${futureMsg}[/info]`);
            }

            // --- 株機能 ---
            const kabuMatch = body.match(/(^|\n)[/#]kabu(?:\s+([^\s]+))?(?:\s+(1d|1w|1m|1y))?/);
            if (kabuMatch && gambleActive) {
                await updateKabuPrice(); 
                let targetKabu = kabuMatch[2];
                let range = kabuMatch[3] || '1d';
                
                if (!targetKabu) {
                    let msg = `[info][title]📈 株式市場一覧[/title]`;
                    msg += `💰 カジノ株: ${formatNumber(kabuData.price)} コイン (保有: ${player.kabu_owned || 0}株 / 残: ${9999 - kabuData.totalIssued})\n`;
                    let myStocks = player.stocks ? JSON.parse(player.stocks) : {};
                    if (kabuData.realStocks) {
                        for (let k in kabuData.realStocks) {
                            msg += `💰 ${k}: ${formatNumber(kabuData.realStocks[k].price)} コイン (保有: ${myStocks[k] || 0}株 / 残: ${9999 - kabuData.realStocks[k].totalIssued})\n`;
                        }
                    }
                    msg += `[hr]※ グラフを見るには /#kabu [銘柄名] [期間(1d/1w/1m/1y)]\n例: /#kabu KADOKAWA 1w\n※ 買うには /#buy-kabu [銘柄名] [個数]\n※ 売るには /#sell-kabu [銘柄名] [個数|all][/info]`;
                    return sendMessage(roomId, msg);
                } else {
                    let kData = null;
                    let pOwned = 0;
                    let pTotal = 0;
                    let kName = targetKabu;
                    let historyData = [];
                    let labels = [];
                    
                    if (targetKabu === 'カジノ株') {
                        kData = kabuData;
                        pOwned = player.kabu_owned || 0;
                        pTotal = kabuData.totalIssued;
                        historyData = kabuData.history;
                        labels = kabuData.history.map((_, i) => {
                            let diff = kabuData.history.length - i - 1;
                            return diff === 0 ? "最新" : `${diff}h前`;
                        }).reverse();
                    } else if (realStockTickers[targetKabu]) {
                        let sData = await fetchStockData(realStockTickers[targetKabu], range);
                        if (sData) {
                            kabuData.realStocks[targetKabu].price = sData.price;
                            await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                            historyData = sData.history;
                            labels = sData.history.map(() => ''); 
                            kData = kabuData.realStocks[targetKabu];
                        } else {
                            return sendTempMessage(roomId, `[info]⚠️ 株価データの取得に失敗しました。[/info]`);
                        }
                        let myStocks = player.stocks ? JSON.parse(player.stocks) : {};
                        pOwned = myStocks[targetKabu] || 0;
                        pTotal = kabuData.realStocks[targetKabu].totalIssued || 0;
                    } else {
                        return sendTempMessage(roomId, `[info]⚠️ 銘柄「${targetKabu}」は見つかりません。[/info]`);
                    }
                    
                    const chartConf = {
                        type: 'line',
                        data: {
                            labels: labels,
                            datasets: [{ label: `${kName}(Coin)`, data: historyData, borderColor: 'green', fill: false, pointRadius: 0 }]
                        },
                        options: { legend: { display: false } }
                    };
                    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConf))}`;
                    try {
                        const imageRes = await axios.get(chartUrl, { responseType: 'arraybuffer' });
                        const imageBuffer = Buffer.from(imageRes.data);
                        const formDataBoundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
                        let postData = `--${formDataBoundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n[info][title]📈 ${kName} 株価チャート (${range})[/title]💰 現在の株価: ${formatNumber(kData.price)} コイン\n📉 市場の残り株数: ${9999 - pTotal} / 9999\n📦 あなたの保有数: ${pOwned} 株[/info]\r\n--${formDataBoundary}\r\nContent-Disposition: form-data; name="file"; filename="kabu_chart.png"\r\nContent-Type: image/png\r\n\r\n`;
                        const payload = Buffer.concat([ Buffer.from(postData, 'utf8'), imageBuffer, Buffer.from(`\r\n--${formDataBoundary}--\r\n`, 'utf8') ]);
                        await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/files`, payload, {
                            headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': `multipart/form-data; boundary=${formDataBoundary}` }
                        });
                    } catch(err) {
                        sendMessage(roomId, `[info][title]📈 ${kName} 株価[/title]💰 現在の株価: ${formatNumber(kData.price)} コイン\n📉 市場の残り株数: ${9999 - pTotal} / 9999\n📦 あなたの保有数: ${pOwned} 株\n(グラフ取得に失敗しました)[/info]`);
                    }
                }
                return;
            }

            const buyKabuMatch = body.match(/(^|\n)[/#]buy-kabu\s+(?:([^\s0-9]+)\s+)?([0-9]+)/);
            if (buyKabuMatch && gambleActive) {
                await updateKabuPrice();
                let kName = buyKabuMatch[2] || 'カジノ株';
                let cnt = parseInt(buyKabuMatch[3], 10);
                
                if (cnt > 0) {
                    if (kName === 'カジノ株') {
                        if (kabuData.totalIssued + cnt > 9999) return sendTempMessage(roomId, `[info]⚠️ 市場に十分な株が残っていません。(残り: ${9999 - kabuData.totalIssued}株)[/info]`);
                        let cost = kabuData.price * cnt;
                        if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ 所持金が足りません。(必要: ${formatNumber(cost)} コイン)[/info]`);
                        
                        kabuData.totalIssued += cnt;
                        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                        await supabase.from('players').update({ money: myMoney - cost, kabu_owned: (player.kabu_owned || 0) + cnt }).eq('account_id', senderId);
                        
                        return sendTempMessage(roomId, `[info]📈 [piconname:${senderId}]\n${kName}を ${cnt} 株購入しました。(-${formatNumber(cost)} コイン)[/info]`);
                    } else if (realStockTickers[kName]) {
                        let sData = await fetchStockData(realStockTickers[kName], '1d');
                        if (sData) kabuData.realStocks[kName].price = sData.price;

                        let rsData = kabuData.realStocks[kName];
                        if (rsData.totalIssued + cnt > 9999) return sendTempMessage(roomId, `[info]⚠️ 市場に十分な株が残っていません。(残り: ${9999 - rsData.totalIssued}株)[/info]`);
                        let cost = rsData.price * cnt;
                        if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ 所持金が足りません。(必要: ${formatNumber(cost)} コイン)[/info]`);
                        
                        rsData.totalIssued += cnt;
                        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                        
                        let myStocks = player.stocks ? JSON.parse(player.stocks) : {};
                        myStocks[kName] = (myStocks[kName] || 0) + cnt;
                        await supabase.from('players').update({ money: myMoney - cost, stocks: JSON.stringify(myStocks) }).eq('account_id', senderId);
                        
                        return sendTempMessage(roomId, `[info]📈 [piconname:${senderId}]\n${kName}を ${cnt} 株購入しました。(-${formatNumber(cost)} コイン)[/info]`);
                    } else {
                        return sendTempMessage(roomId, `[info]⚠️ 銘柄「${kName}」は見つかりません。[/info]`);
                    }
                }
            }

            const sellKabuMatch = body.match(/(^|\n)[/#]sell-kabu\s+(?:(?!all\b)([^\s0-9]+)\s+)?(all|[0-9]+)/i);
            if (sellKabuMatch && gambleActive) {
                await updateKabuPrice();
                let kName = sellKabuMatch[2] || 'カジノ株';
                let cntStr = sellKabuMatch[3].toLowerCase();
                
                if (kName === 'カジノ株') {
                    let cnt = cntStr === 'all' ? (player.kabu_owned || 0) : parseInt(cntStr, 10);
                    if (cnt > 0 && (player.kabu_owned || 0) >= cnt) {
                        let revenue = kabuData.price * cnt;
                        kabuData.totalIssued -= cnt;
                        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                        await supabase.from('players').update({ kabu_owned: player.kabu_owned - cnt }).eq('account_id', senderId);
                        await addMoney(senderId, revenue);
                        return sendTempMessage(roomId, `[info]📉 [piconname:${senderId}]\n${kName}を ${cnt} 株売却しました。(+${formatNumber(revenue)} コイン)[/info]`);
                    } else return sendTempMessage(roomId, `[info]⚠️ 指定した数の株を所持していません。[/info]`);
                } else if (kabuData.realStocks && kabuData.realStocks[kName]) {
                    let myStocks = player.stocks ? JSON.parse(player.stocks) : {};
                    let pOwned = myStocks[kName] || 0;
                    let cnt = cntStr === 'all' ? pOwned : parseInt(cntStr, 10);
                    if (cnt > 0 && pOwned >= cnt) {
                        let revenue = kabuData.realStocks[kName].price * cnt;
                        kabuData.realStocks[kName].totalIssued -= cnt;
                        await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                        
                        myStocks[kName] = pOwned - cnt;
                        await supabase.from('players').update({ stocks: JSON.stringify(myStocks) }).eq('account_id', senderId);
                        await addMoney(senderId, revenue);
                        return sendTempMessage(roomId, `[info]📉 [piconname:${senderId}]\n${kName}を ${cnt} 株売却しました。(+${formatNumber(revenue)} コイン)[/info]`);
                    } else return sendTempMessage(roomId, `[info]⚠️ 指定した数の株を所持していません。[/info]`);
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ 銘柄「${kName}」は見つかりません。[/info]`);
                }
            }

            const helpMatch = body.trim().match(/^[/#]help\s+([a-zA-Z]+)$/);
            if (helpMatch) {
                let g = helpMatch[1].toLowerCase();
                let txt = "";
                if (g === 'poker') txt = `[title]🃏 ポーカーのルール[/title]ディーラーと1対1で役の強さを競います。\n配られた5枚のカードを1回だけ交換できます。\n【配当】ディーラーより強ければ 賭け金×2 (利益+100%)。引き分けは返金。\n【役の強さ】ロイヤル > ストフラ > 4カード > フルハウス > フラッシュ > ストレート > 3カード > 2ペア > 1ペア > ノーペア`;
                else if (g === 'yacht') txt = `[title]🎲 ヨットのルール[/title]ディーラーと5つのサイコロの役の強さを競います。\nサイコロは最大2回まで(計3投)振り直せます。\n【配当】ディーラーより強ければ 賭け金×2。引き分けは返金。\n【注意】「役なし」は無条件で没収。`;
                else if (g === 'bj') txt = `[title]🃏 ブラックジャックのルール[/title]カードの合計を「21」に近づけるゲーム。\n21を超えるとバースト(即負け)。\n【配当】勝てば 2倍。最初から21(BJ)なら 2.5倍！`;
                else if (g === 'cc') txt = `[title]🎲 チンチロリンのルール[/title]サイコロを3つ振り、親(ディーラー)と出目を競います。\n同じ目が2つ出た時、残りの1つが「出目」になります。\n【配当】役の倍率に応じて賭け金が増減。`;
                else if (g === 'derby') txt = `[title]🐎 ダービーのルール[/title]6頭の馬から、1位と2位になる馬の組み合わせ(馬連)を予想します。\nオッズに従って配当が変動します。( /#bet 100 1-2 のように馬番を指定 )`;
                else if (g === 'chouhan') txt = `[title]🎲 丁半のルール[/title]2つのサイコロの合計が「丁(偶数)」か「半(奇数)」かを予想します。\n的中すれば賭け金が2倍になります。`;
                else if (g === 'sicbo') txt = `[title]🎲 シックボー(大小)のルール[/title]3つのサイコロを振ります。\n合計が11〜17なら「dai(大)」、4〜10なら「shou(小)」。ゾロ目なら「any」です。\n【配当】大・小 (1.8倍) / エニートリプル (15倍)`;
                else if (g === 'rolet') txt = `[title]🎡 ルーレットのルール[/title]数字(0〜36)や属性にベットします。\n/#bet 100 red (赤), black (黒), even (偶数), odd (奇数), high (19-36), low (1-18)\nまたは /#bet 100 5 のように数字を指定できます。\n【配当】属性は 2倍。数字単体は 36倍。`;
                else if (g === 'buta') txt = `[title]🐷 豚のしっぽのルール[/title]ディーラーとチキンレースをします。\n/#draw でカードを引き、直前に引いたカードと「同じマーク(スート)」が出たらドボン(即負け)。\n【配当】ディーラーより引いた枚数が多ければ 賭け金×2。引き分けは返金。`;
                else if (g === 'daifugo') txt = `[title]👑 大富豪のルール[/title]各プレイヤーに個別の「手札部屋」が作られます。\n手札部屋から /#play S3 や /#play H4 D4 のように出して進行します。\n出せない場合は /#pass してください。\n【特殊ルール】8切り、革命、イレブンバック\n【配当】1位(大富豪): 3倍、2位(富豪): 1.5倍、それ以外は没収。`;
                else if (g === 'crash') txt = `[title]🚀 クラッシュのルール[/title]ゲームが始まると倍率が 1.00x からどんどん上昇していきますが、ランダムなタイミングで爆発(クラッシュ)します。\nあらかじめ「目標倍率」を設定しておき、その倍率に到達する前にクラッシュしなければ利確成功となります。\n(参加例: /#bet 1000 2.5 と打つと、2.5倍に到達で勝利。それより前にクラッシュすると没収。)`;
                else if (g === 'highlow') txt = `[title]🃏 ハイローのルール[/title]ディーラーが2枚のカード(1〜13)を引き、2枚目のカードが1枚目より大きい(high)か、小さい(low)かを当てるゲームです。\n(参加例: /#bet 1000 high )\n【配当】予想的中なら 賭け金×2。同数だった場合はDraw(返金)となります。`;
                else txt = `指定されたゲームのルールは見つかりませんでした。`;
                return sendTempMessage(roomId, `[info]${txt}[/info]`, 120000);
            }

            if (/(^|\n)[/#]help-gya\b/.test(body)) {
                const helpMsg = `[info][title]🎰 カジノ＆ライフ 総合案内 (V56 Ultra Update)[/title]
【 🏦 銀行・株式 】
/#status : 状態確認(所持金, 預金, 戦績, 純資産など)
/#deposit [金額|max|half] : 所持金を銀行へ預け入れる
/#withdraw [金額|max|half] : 銀行から引き出す
/#give [金額] : 相手に送金 (税金10%, 1日最大50万まで)
/#kabu : 株式市場の一覧を見る
/#kabu [銘柄] [期間(1d/1w/1m/1y)] : 特定の銘柄のチャートを見る
/#buy-kabu [銘柄] [個数], /#sell-kabu [銘柄] [個数|all] : 株の売買
/#money-rank : 純資産ランキング
/#winner-rank : 勝利数ランキング
/#rtp-rank : RTP(回収率)ランキング
/#winrate-rank : 勝率ランキング
/#worst-rank : ワーストランキング (直近3日)
/#daily-rank : デイリー獲得金ランキング

【 💼 職業・スキル 】
/#job : 転職と求人
/#work : 職業給料 (1分に1回, 1日10回上限)
/#catch または /#goal : 職業専用能力
/#owner : [ギャンブルオーナー] 30分間、他人の負け金を回収 (1日1回)
/#next-future : [未来人] ゲーム結果を予知 (1日1回)
/#bounty [aid] : [賞金稼ぎ] ターゲットが次に負けた際、負け金の10%を奪う
※ [賭博師]、[逆転のギャンブラー]、[銀行員]、[大富豪の執事]、[数学者] は自動スキルです。
/#omikuji : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
/#slot [掛金|max|half] : スロット (最大ベット 999万)
/#scratch [掛金] : 一人完結型スクラッチくじ。最大配当50倍。

【 🏪 ショップ・闇市 】
/#shop : 通常ショップ(アイテム購入)
/#blackmarket : 闇市(5%の確率で出現)
/#buy [アイテム名] : アイテムを購入

【 🎲 テーブルゲーム 】 (詳しいルールは /#help [ゲーム名])
※ コマンドは全て / (スラッシュ) でも動作します。 (例: /slot 100)
※ 1回のゲームの最大ベット額は 999万 までです。
※ /#bet life : 命を賭ける (8連勝した者のみ使用可能。成功で所持金+銀行が8~15倍。失敗で永久出禁)
※ 全てのゲームは1人から開始可能です。
/#highlow : ハイロー募集 (/#bet [額] [high/low])
/#crash : クラッシュ募集 (/#bet [額] [目標倍率(1.01~)])
/#chouhan : 丁半ゲーム募集
/#sicbo : シックボー募集 (/#bet [額] [dai/shou/any])
/#cc : チンチロリン募集 (参加者は /#roll)
/#rolet : ルーレット募集 (/#bet [額] [red/even/数字など])
/#derby : ダービー募集 (/#bet [額] [馬番-馬番])
/#bj : ブラックジャック募集 (/#hit か /#stand)
/#poker : ポーカー募集 (/#change [番号] か /#stand)
/#yacht : ヨット募集 (/#change [番号] か /#stand)
/#buta : 豚のしっぽ募集 (/#draw か /#stand)
/#daifugo : 大富豪募集 (個別部屋連動システム！)

【 👑 管理者専用 】
/#take [金], /#fi-game, /#st-gya, /#fi-gya, /#blacklist 等[/info]`;
                return sendTempMessage(roomId, helpMsg, 120000);
            }

            if (/(^|\n)[/#]take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let takeMatch = body.match(/(?:^|\n)[/#]take\s+(.*)/);
                if (takeMatch) {
                    let args = takeMatch[1].trim().split(/\s+/);
                    let targetAid = repliedAid;
                    let amtStr = null;
                    if (args.length === 1 && targetAid) amtStr = args[0];
                    else if (args.length >= 2) { targetAid = args[0]; amtStr = args[1]; }
                    if (targetAid && amtStr) {
                        let amt = parseInt(amtStr, 10);
                        if (!isNaN(amt) && amt !== 0) {
                            await addMoney(targetAid, amt);
                            let action = amt > 0 ? "付与しました" : "没収しました";
                            return sendTempMessage(roomId, `[info][title]👑 特別資金操作[/title]管理者が [piconname:${targetAid}] 様へ ${formatNumber(Math.abs(amt))} コインを${action}。[/info]`); 
                        }
                    }
                }
            }

            if (/(^|\n)[/#]fi-game\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                if (gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                    for (let p of gameState[roomId].players) {
                        if (p.bet > 0) await addMoney(p.aid, p.bet);
                    }
                    clearTimeout(gameState[roomId].timeoutId);
                    if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                    gameState[roomId] = null;
                    return sendTempMessage(roomId, `[info][title]⚠️ ゲーム強制終了[/title]管理者によってゲームが強制終了されました。\n(※賭け金は全額返還されました)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }

            if (/(^|\n)[/#](blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                let targetAid = repliedAid || (body.match(/(^|\n)[/#](?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('remove-rank') ? 'rank' : (body.includes('reblacklist') ? 'remove' : 'add');
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

            if (body.match(/^[/#]st-gya/) && await isUserAdmin(roomId, senderId)) { 
                gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); 
                return sendMessage(roomId, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); 
            }
            if (body.match(/^[/#]fi-gya/) && await isUserAdmin(roomId, senderId)) { 
                gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); 
                return sendMessage(roomId, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); 
            }

            const depMatch = body.match(/(^|\n)[/#]deposit\s+(max|half|[0-9]+)/);
            if (depMatch && gambleActive) {
                let amt = depMatch[2] === 'max' ? myMoney : (depMatch[2] === 'half' ? Math.floor(myMoney/2) : parseInt(depMatch[2], 10));
                if (amt > 0 && myMoney >= amt) {
                    await supabase.from('players').update({ money: myMoney - amt, bank: myBank + amt }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info]🏦 [piconname:${senderId}]\n${formatNumber(amt)} コインを銀行に預け入れました。\n預金残高: ${formatNumber(myBank + amt)} コイン[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ 手持ちの所持金が足りません。[/info]`);
            }

            const witMatch = body.match(/(^|\n)[/#]withdraw\s+(max|half|[0-9]+)/);
            if (witMatch && gambleActive) {
                let amt = witMatch[2] === 'max' ? myBank : (witMatch[2] === 'half' ? Math.floor(myBank/2) : parseInt(witMatch[2], 10));
                if (amt > 0 && myBank >= amt) {
                    await supabase.from('players').update({ bank: myBank - amt }).eq('account_id', senderId);
                    await addMoney(senderId, amt);
                    return sendTempMessage(roomId, `[info]🏦 [piconname:${senderId}]\n銀行から ${formatNumber(amt)} コインを引き出しました。[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ 預金残高が足りません。[/info]`);
            }

            if (/(^|\n)[/#]give\b/.test(body) && gambleActive) {
                let targetAid = repliedAid || (body.match(/(^|\n)[/#]give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)[/#]give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)[/#]give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (targetAid && amt > 0) {
                    let netWorth = myMoney + myBank;
                    if (netWorth < amt) return sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n純資産が不足しています！\n送金可能額は純資産分(${formatNumber(Math.max(0, netWorth))} コイン)までです。[/info]`);
                    if (myMoney < amt) return sendTempMessage(roomId, `[info]手持ちの所持金が不足しています。\n預金がある場合は /withdraw で手元に引き出してください。[/info]`);
                    
                    let currentGiveAmount = (player.last_give_date === today) ? (player.daily_give_amount || 0) : 0;
                    if (currentGiveAmount + amt > 500000) return sendTempMessage(roomId, `[info][title]⚠️ 送金上限エラー[/title]1日の送金上限(500,000 コイン)を超過します！\n(本日は既に ${formatNumber(currentGiveAmount)} コイン送金しています)[/info]`);
                    
                    let tax = Math.floor(amt * 0.10); let rAmt = amt - tax;
                    await supabase.from('players').update({ money: myMoney - amt, daily_give_amount: currentGiveAmount + amt, last_give_date: today }).eq('account_id', senderId);
                    await addMoney(targetAid, rAmt);
                    return sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${formatNumber(amt)} コインを送金しました。\n[hr]※システム税 10% (${formatNumber(tax)} コイン) が引かれ、相手には ${formatNumber(rAmt)} コインが届きました。[/info]`);
                }
            }
            if (/(^|\n)\/money-rank\b/.test(body)) {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let price = kabuData.price || 1000;
                let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                
                f.sort((a,b) => ((b.money||0) + (b.bank||0) + ((b.kabu_owned||0)*price)) - ((a.money||0) + (a.bank||0) + ((a.kabu_owned||0)*price)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) + (d.bank||0) + ((d.kabu_owned||0)*price); 
                    let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    let lastLoginStr = d.last_daily_date ? (d.last_daily_date === today ? "本日" : `${getDiffDays(d.last_daily_date, today)}日前`) : "未ログイン";
                    return `${md} ${i+1}位: [piconname:${d.account_id}] (最終: ${lastLoginStr})\n　💎 純資産: ${formatNumber(net)} コイン [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                
                return sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }
            if (/(^|\n)[/#]status\b/.test(body)) {
                let targetPlayer = player;
                let targetAid = senderId;
                
                if (repliedAid) {
                    const { data: repPlayer } = await supabase.from('players').select('*').eq('account_id', repliedAid).single();
                    if (repPlayer) {
                        targetPlayer = repPlayer;
                        if (typeof targetPlayer.items === 'string') targetPlayer.items = JSON.parse(targetPlayer.items || '{}');
                        targetAid = repliedAid;
                    } else {
                        return sendTempMessage(roomId, `[info]⚠️ 対象のプレイヤーデータが見つかりません。[/info]`);
                    }
                }

                let tMoney = targetPlayer.money || 0;
                let tBank = targetPlayer.bank || 0;
                let tJob = targetPlayer.job || 'サラリーマン';
                let tPlays = targetPlayer.plays || 0;
                let tWins = targetPlayer.wins || 0;
                let tLoses = targetPlayer.loses || 0;
                let tTotalBet = targetPlayer.total_bet || 0;
                let tTotalReturn = targetPlayer.total_return || 0;

                const remSlot = Math.max(0, 5 - (targetPlayer.slot_count || 0));
                const bStr = `\n🏦 預金残高: ${formatNumber(tBank)} コイン`;
                const streakStr = `\n🔥 連勝記録: ${targetPlayer.win_streak || 0} 連勝`;
                
                let kabuStr = '';
                if ((targetPlayer.kabu_owned || 0) > 0) kabuStr += `\n📦 カジノ株: ${targetPlayer.kabu_owned} 株`;
                if (targetPlayer.stocks) {
                    let s = JSON.parse(targetPlayer.stocks);
                    for (let k in s) {
                        if (s[k] > 0) kabuStr += `\n📦 ${k}: ${s[k]} 株`;
                    }
                }
                
                let itemStr = '';
                if (targetPlayer.items) {
                    let hasItems = false;
                    for (let itemName in targetPlayer.items) {
                        if (targetPlayer.items[itemName] > 0) {
                            itemStr += `\n🛍️ ${itemName}: ${targetPlayer.items[itemName]}個`;
                            hasItems = true;
                        }
                    }
                    if (hasItems) itemStr = "\n[hr]【 所持アイテム 】" + itemStr;
                }

                const netWorth = calculateNetWorth(targetPlayer);
                const lastLoginStr = targetPlayer.last_daily_date ? (targetPlayer.last_daily_date === today ? "本日" : `${getDiffDays(targetPlayer.last_daily_date, today)}日前`) : "未ログイン";

                let wr = tPlays ? ((tWins / tPlays) * 100).toFixed(1) : 0;
                let rtp = tTotalBet ? ((tTotalReturn / tTotalBet) * 100).toFixed(1) : 0;
                const statsStr = `\n⚔️ 戦績: ${tPlays}戦 / ${tWins}勝 / ${tLoses}敗\n📈 勝率: ${wr}% / 💹 RTP: ${rtp}%`;

                return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${targetAid}] 様 (最終ログイン: ${lastLoginStr})\n\n💰 所持金: ${formatNumber(tMoney)} コイン${bStr}${kabuStr}\n💎 純資産: ${formatNumber(netWorth)} コイン${streakStr}${statsStr}\n[hr]👔 職業: ${tJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${targetPlayer.work_limit || 0} 回\n⛩️ 今日の運勢: ${targetPlayer.omikuji_result || '未引'}${itemStr}\n[hr]※1分後に自動消去されます[/info]`);
            }

            const cJobMatch = body.match(/(^|\n)[/#]job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|ギャンブルオーナー|未来人|逆転のギャンブラー|銀行員|大富豪の執事|賞金稼ぎ|数学者)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {
                    'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, 
                    '賭博師': 200000, 'ギャンブルオーナー': 1000000, '未来人': 5000000,
                    '逆転のギャンブラー': 1000000, '銀行員': 1000000, '大富豪の執事': 400000,
                    '賞金稼ぎ': 10000, '数学者': 50000
                };
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (/(^|\n)[/#]job\b/.test(body) && !body.match(/(^|\n)[/#]job\s+/) && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)\n ▶ /#work (400〜2000) ※10%でミス0
🏛️ 公務員 (費用: 2000)\n ▶ /#work (1200〜2000)
🚓 警察官 (費用: 3000)\n ▶ /#work (1200〜2800)\n ▶ /#catch (30%の確率で犯人逮捕! 3200)
⚽ プロスポーツ選手 (費用: 5000)\n ▶ /#work (2000〜4000)\n ▶ /#goal (30%の確率でゴール! 4000)
🎰 賭博師 (費用: 200,000)\n ▶ 毎日初回ログイン時にスロット回数が自動で5〜10回分増加
👑 ギャンブルオーナー (費用: 1,000,000)\n ▶ /#owner (1日1回、30分間他人のギャンブル負け金の50%を50%で回収)
👁️ 未来人 (費用: 5,000,000)\n ▶ /#next-future (1日1回、70%の確率で現在進行中のゲームの未来を予知)
🔄 逆転のギャンブラー (費用: 1,000,000)\n ▶ ギャンブルに負けた時、RTPが低いと80%の確率で賭け金が戻ってくる
🏦 銀行員 (費用: 1,000,000)\n ▶ 毎日初回ログイン時に、銀行の預金に1%の複利利息が付与される
🎩 大富豪の執事 (費用: 400,000)\n ▶ ランキング1位の人が100万以上稼ぐ度に、その利益の1%を給与として得る
🎯 賞金稼ぎ (費用: 10,000)\n ▶ /#bounty [aid] でターゲット指定。その人が次に負けた時、負け金の10%を報酬として奪う
🧮 数学者 (費用: 50,000)\n ▶ ルーレットの赤黒・偶数奇数等の2倍配当が「2.1倍」になる
[hr]※転職コマンド: /#job 役職名[/info]`);
            }

            if (/(^|\n)[/#]owner\b/.test(body) && gambleActive) {
                if (myJob !== 'ギャンブルオーナー') return sendTempMessage(roomId, `[info]⚠️ ギャンブルオーナー専用のコマンドです。[/info]`);
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ オーナースキルは1日1回までです。[/info]`);
                let now = Date.now();
                if (ownerSkill.expire > now) {
                    if (ownerSkill.aid === senderId) return sendTempMessage(roomId, `[info]⚠️ あなたは既に能力を発動中です！(残り: ${Math.ceil((ownerSkill.expire - now)/60000)}分)[/info]`);
                    else return sendTempMessage(roomId, `[info]⚠️ 現在、他のギャンブルオーナーが能力を発動中です。しばらくお待ちください。[/info]`);
                }
                ownerSkill.aid = senderId;
                ownerSkill.expire = now + 30 * 60 * 1000;
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]👑 オーナー権限発動[/title][piconname:${senderId}]\nここから30分間、他人がギャンブルで負けた金額の50%を50%の確率で回収します...！[/info]`);
            }

            if (/(^|\n)[/#]work\b/.test(body) && gambleActive) {
                if (player.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日の仕事回数が上限(10回)に達しました。[/info]`);
                if (Date.now() - (player.last_work_time || 0) < 60000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n休憩中です！仕事は1分間隔で行えます。[/info]`);
                
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*1601)+400; m=`真面目に働き、 ${formatNumber(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*801)+1200; m=`安定した仕事をこなし、 ${formatNumber(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*1601)+1200; m=`街の平和を守り、 ${formatNumber(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*2001)+2000; m=`試合で大活躍し、 ${formatNumber(e)} コイン稼ぎました！⚽`; }
                else if(myJob === '賭博師'){ e=Math.floor(Math.random()*3001)+1000; m=`裏社会の仕事をこなし、 ${formatNumber(e)} コイン稼ぎました！🎰`; }
                else if(myJob === 'ギャンブルオーナー'){ e=Math.floor(Math.random()*5001)+3000; m=`経営するカジノの利益として、 ${formatNumber(e)} コインを手に入れました！👑`; }
                else if(myJob === '未来人'){ e=Math.floor(Math.random()*10001)+5000; m=`未来の株価を予測し、 ${formatNumber(e)} コイン稼ぎました！👁️`; }
                else if(myJob === '逆転のギャンブラー'){ e=Math.floor(Math.random()*2001)+1000; m=`危ない橋を渡り、 ${formatNumber(e)} コイン稼ぎました！🔄`; }
                else if(myJob === '銀行員'){ e=Math.floor(Math.random()*1501)+2000; m=`融資の手続きをこなし、 ${formatNumber(e)} コイン稼ぎました！🏦`; }
                else if(myJob === '大富豪の執事'){ e=Math.floor(Math.random()*1201)+800; m=`主のお世話をし、 ${formatNumber(e)} コイン稼ぎました！🎩`; }
                else if(myJob === '賞金稼ぎ'){ e=Math.floor(Math.random()*2001)+500; m=`小悪党を捕まえ、 ${formatNumber(e)} コイン稼ぎました！🎯`; }
                else if(myJob === '数学者'){ e=Math.floor(Math.random()*2001)+1500; m=`新たな公式を証明し、 ${formatNumber(e)} コイン稼ぎました！🧮`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoney(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            const sM = body.match(/(^|\n)[/#]slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (player.slot_count >= 5) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 60000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(1分間隔)です！[/info]`);
                
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
                    
                    if (ml > 0 && await consumeItem(senderId, 'ダブルアップ・コイン')) {
                        ml *= 2; res += `\n🪙 ダブルアップ！`;
                    }

                    let wA = bet * ml; 
                    if (wA > 0) {
                        let stolen = await processJoker(senderId, wA, roomId);
                        wA -= stolen;
                        await addMoney(senderId, wA);
                        await updatePlayerStats(senderId, bet, wA, 'win');
                        kabuData.pendingProfit = (kabuData.pendingProfit || 0) - (wA - bet);
                        await processButler(senderId, wA, roomId);
                    } else {
                        let refunded = await processGamblerSkill(senderId, bet, roomId);
                        if (refunded) {
                            res += `\n(🔄 逆転スキルで返金!)`;
                            await updatePlayerStats(senderId, bet, bet, 'draw');
                        } else {
                            await processOwnerSkill(senderId, bet, roomId);
                            await processBounty(senderId, bet, roomId);
                            await updatePlayerStats(senderId, bet, 0, 'lose');
                            kabuData.pendingProfit = (kabuData.pendingProfit || 0) + bet;
                        }
                    }
                    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
                    
                    let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎰 SLOT MACHINE 回転中...\n[ ❓ | ❓ | ❓ ][/info]`)}`);
                    if (msgRes && msgRes.data) {
                        let mId = msgRes.data.message_id;
                        const syms = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣","🍒","🐉"];
                        let finalSyms = sy.split(" | ");
                        
                        for(let i=0; i<8; i++) {
                            await sleep(350);
                            let t1=syms[Math.floor(Math.random()*syms.length)], t2=syms[Math.floor(Math.random()*syms.length)], t3=syms[Math.floor(Math.random()*syms.length)];
                            await editMessage(roomId, mId, `[info]🎰 SLOT MACHINE 回転中...\n[ ${t1} | ${t2} | ${t3} ][/info]`);
                        }
                        let s1 = finalSyms[0];
                        for(let i=0; i<4; i++) {
                            await sleep(350);
                            let t2=syms[Math.floor(Math.random()*syms.length)], t3=syms[Math.floor(Math.random()*syms.length)];
                            await editMessage(roomId, mId, `[info]🎰 SLOT MACHINE 回転中...\n[ ${s1} | ${t2} | ${t3} ][/info]`);
                        }
                        let s2 = finalSyms[1];
                        for(let i=0; i<5; i++) {
                            await sleep(350);
                            let t3=syms[Math.floor(Math.random()*syms.length)];
                            await editMessage(roomId, mId, `[info]🎰 SLOT MACHINE 回転中...\n[ ${s1} | ${s2} | ${t3} ][/info]`);
                        }
                        await editMessage(roomId, mId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り回数: ${Math.max(0, 5 - (player.slot_count + 1))}回)[/info]`);
                    } else {
                        return sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り回数: ${Math.max(0, 5 - (player.slot_count + 1))}回)[/info]`);
                    }
                } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- ゲーム募集コマンドの検知 ---
            const gameCmdMatch = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian|highlow)\b/);
            if (gameCmdMatch && gambleActive) {
                if (gameState[roomId]) {
                    return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                }
                
                let t = gameCmdMatch[2]; 
                gameState[roomId] = { 
                    type: t, 
                    state: 'RECRUITING', 
                    host: senderId, 
                    players: [{ aid: senderId, bet: 0 }], 
                    spectators: [] 
                };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : 
                         t==='cc' ? "🎲 チンチロリン" : 
                         t==='bj' ? "🃏 ブラックジャック" : 
                         t==='poker' ? "🃏 ポーカー" : 
                         t==='yacht' ? "🎲 ヨット" : 
                         t==='sicbo' ? "🎲 シックボー(大小)" : 
                         t==='rolet' ? "🎡 ルーレット" : 
                         t==='buta' ? "🐷 豚のしっぽ" : 
                         t==='daifugo' ? "👑 大富豪" : 
                         t==='russian' ? "🔫 ロシアンルーレット" : 
                         t==='highlow' ? "🃏 ハイロー" : "🎲 丁半ゲーム";
                
                let ex = `/#join`;
                let ruleAdd = t === 'russian' ? "\n(※全員で /#join 後、開始時にランダムで2名がプレイヤーになります)" : "\n(※一人からでも開始可能です)";
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; 
                    gameState[roomId].oddsStr = dO.oddsStr; 
                    gameState[roomId].st = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加希望者は ${ex} と入力してください！ (現在 1人)\n[hr]※1分経過またはホストが /#start と入力すると開始します。${ruleAdd}[/info]`); 
                
                startGameTimer(roomId); 
                return;
            }

            if (body.match(/(^|\n)[/#]join\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                let g = gameState[roomId];
                if (!g.players.find(x => x.aid === senderId)) { 
                    g.players.push({ aid: senderId, bet: 0 }); 
                    let ex = g.type === 'russian' ? "\n※開始時にランダムで2名がプレイヤーに選ばれます" : "";
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${g.players.length}人)${ex}[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)[/#]start\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                clearTimeout(gameState[roomId].timeoutId); 
                handleGameTimeout(roomId); 
                return;
            }

            if (/(^|\n)[/#]leave\b/.test(body) && gambleActive && gameState[roomId]) {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                let spIdx = gameState[roomId].spectators ? gameState[roomId].spectators.findIndex(s => s.aid === senderId) : -1;

                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; 
                    gameState[roomId].players.splice(idx, 1);
                    
                    let pMsg = p.bet > 0 || p.isLifeBet ? " (賭け金没収)" : "";
                    if (p.isLifeBet) {
                        await supabase.from('blacklist').insert({ account_id: p.aid });
                        await updateRoomMembers(roomId, [p.aid], 'readonly');
                        pMsg = " (命賭けキャンセルペナルティ: 永久追放)";
                    } else if (p.bet > 0) {
                        await supabase.from('players').update({ win_streak: 0, life_bet_unlocked: false }).eq('account_id', senderId);
                    }

                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。${pMsg}[/info]`);
                    
                    if (gameState[roomId].players.length === 0 || (gameState[roomId].type === 'russian' && gameState[roomId].players.length < 2)) { 
                        clearTimeout(gameState[roomId].timeoutId); 
                        if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者が規定人数未満になったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                } else if (spIdx !== -1) {
                    let s = gameState[roomId].spectators[spIdx];
                    gameState[roomId].spectators.splice(spIdx, 1);
                    let pMsg = s.bet > 0 ? " (賭け金没収)" : "";
                    if (s.bet > 0) await processOwnerSkill(s.aid, s.bet, roomId);
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が観戦から退出しました。${pMsg}[/info]`);
                    checkGameProgress(roomId);
                }
                return;
            }

            const bM = body.match(/(^|\n)[/#]bet\s+(max|half|life|[0-9]+)(?:\s+([a-zA-Z0-9-.]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let g = gameState[roomId];
                
                let pl = g.players.find(x => x.aid === senderId);
                let sp = g.spectators ? g.spectators.find(x => x.aid === senderId) : null;

                if (pl && pl.bet === 0 && !pl.pendingLifeBet) {
                    let betType = bM[2];

                    if (betType === 'life') {
                        if (g.type === 'russian') return sendTempMessage(roomId, `[info]⚠️ ロシアンルーレットでは /#bet life は使用できません。[/info]`);
                        if (!player.life_bet_unlocked) return sendTempMessage(roomId, `[info]⚠️ /#bet life は8連勝した者のみが使える特権です。[/info]`);
                        
                        if (g.type === 'derby') {
                            let h = bM[3]; if (!h || !g.oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連を正しく指定してください\n例: /#bet life 1-2[/info]`); pl.pendingChoice = h;
                        } else if (g.type === 'sicbo') {
                            let h = bM[3]; if (!h || !['dai','shou','any'].includes(h)) return sendTempMessage(roomId, `[info]⚠️ 予想(dai/shou/any)を正しく指定してください\n例: /#bet life dai[/info]`); pl.pendingChoice = h;
                        } else if (g.type === 'rolet') {
                            let h = bM[3]; if (!h || (!['red','black','even','odd','high','low'].includes(h) && (isNaN(parseInt(h)) || parseInt(h) < 0 || parseInt(h) > 36))) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /#bet life red[/info]`); pl.pendingChoice = h;
                        } else if (g.type === 'crash') {
                            let h = bM[3]; let tm = parseFloat(h); if (!h || isNaN(tm) || tm <= 1.00) return sendTempMessage(roomId, `[info]⚠️ 目標倍率(1.01以上)を正しく指定してください\n例: /#bet life 2.5[/info]`); pl.pendingChoice = tm.toFixed(2);
                        } else if (g.type === 'highlow') {
                            let h = bM[3]; if (!h || !['high','low'].includes(h.toLowerCase())) return sendTempMessage(roomId, `[info]⚠️ 予想(high/low)を指定してください\n例: /#bet life high[/info]`); pl.pendingChoice = h.toLowerCase();
                        }
                        pl.pendingLifeBet = true;
                        return sendTempMessage(roomId, `[info]⚠️ 【命賭けの確認】\nこれに失敗すると永久に出禁になりますが、成功すると持ち金(銀行含む)が8〜15倍になります。\n本当によろしいですか？\nよろしければ yes 、やめる場合は no と発言してください。[/info]`);
                    } else {
                        let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                        if (b > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);

                        if (b > 0 && myMoney >= b) {
                            if (g.type === 'russian') {
                                if (!g.minBet) {
                                    let opponent = g.players.find(p => p.aid !== senderId);
                                    let { data: oppData } = await supabase.from('players').select('money, bank').eq('account_id', opponent.aid).single();
                                    let oppTotal = (oppData?.money || 0) + (oppData?.bank || 0);
                                    let maxAllowed = Math.floor(oppTotal / 2);
                                    
                                    if (b >= maxAllowed) return sendTempMessage(roomId, `[info]⚠️ 相手の全財産の半分(${formatNumber(maxAllowed)})未満の金額を設定してください。[/info]`);
                                    
                                    g.minBet = b;
                                    pl.bet = b;
                                    await addMoney(senderId, -b);
                                    sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] が 最低賭け金 ${formatNumber(b)} コイン に設定しました！\n相手は /#bet ${b} 以上の金額をベットしてください。[/info]`);
                                } else {
                                    if (b < g.minBet) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金(${formatNumber(g.minBet)} コイン)以上をベットしてください。[/info]`);
                                    pl.bet = b;
                                    await addMoney(senderId, -b);
                                    sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] が ${formatNumber(b)} コイン をベットしました！[/info]`);
                                }
                                checkGameProgress(roomId);
                                return;
                            }

                            if (g.type === 'derby') {
                                let h = bM[3]; if (!h || !g.oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連を正しく指定してください\n例: /#bet 100 1-2[/info]`); pl.choice = h;
                            } else if (g.type === 'sicbo') {
                                let h = bM[3]; if (!h || !['dai','shou','any'].includes(h)) return sendTempMessage(roomId, `[info]⚠️ 予想(dai/shou/any)を正しく指定してください\n例: /#bet 100 dai[/info]`); pl.choice = h;
                            } else if (g.type === 'rolet') {
                                let h = bM[3]; if (!h || (!['red','black','even','odd','high','low'].includes(h) && (isNaN(parseInt(h)) || parseInt(h) < 0 || parseInt(h) > 36))) return sendTempMessage(roomId, `[info]⚠️ 予想を正しく指定してください\n例: /#bet 100 red[/info]`); pl.choice = h;
                            } else if (g.type === 'crash') {
                                let h = bM[3]; let tm = parseFloat(h); if (!h || isNaN(tm) || tm <= 1.00) return sendTempMessage(roomId, `[info]⚠️ 目標倍率(1.01以上)を指定してください\n例: /#bet 100 2.5[/info]`); pl.choice = tm.toFixed(2);
                            } else if (g.type === 'highlow') {
                                let h = bM[3]; if (!h || !['high','low'].includes(h.toLowerCase())) return sendTempMessage(roomId, `[info]⚠️ 予想(high/low)を指定してください\n例: /#bet 100 high[/info]`); pl.choice = h.toLowerCase();
                            }
                            pl.bet = b; 
                            let updates = { money: myMoney - b };
                            if (player.life_bet_unlocked) { updates.life_bet_unlocked = false; sendTempMessage(roomId, `[info]※通常のベットを行ったため、命賭けの権利は消滅しました。[/info]`); }
                            await supabase.from('players').update(updates).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${formatNumber(b)} コインをベットしました！[/info]`);
                            checkGameProgress(roomId);
                        } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
                    }
                } else if (sp && sp.bet === 0) {
                    let betType = bM[2];
                    if (betType === 'life') return sendTempMessage(roomId, `[info]⚠️ 観戦者は命を賭けられません。[/info]`);
                    
                    let targetAid = repliedAid || bM[3];
                    if (!targetAid || !g.players.find(p => p.aid === targetAid)) {
                        return sendTempMessage(roomId, `[info]⚠️ 応援するプレイヤーのaidを指定するか、その人に返信してベットしてください。\n例: /#bet 100 123456[/info]`);
                    }

                    let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                    if (b > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);

                    if (b > 0 && myMoney >= b) {
                        sp.bet = b;
                        sp.targetAid = targetAid;
                        await addMoney(senderId, -b);
                        sendTempMessage(roomId, `[info]👀 [piconname:${senderId}] が [piconname:${targetAid}] の勝利に ${formatNumber(b)} コインベットしました！[/info]`);
                        checkGameProgress(roomId);
                    } else {
                        return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
                    }
                }
                return;
            }

            if ((body.trim().toLowerCase() === 'yes' || body.trim().toLowerCase() === 'no') && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.pendingLifeBet) {
                    if (body.trim().toLowerCase() === 'yes') {
                        pl.isLifeBet = true;
                        if (pl.pendingChoice) pl.choice = pl.pendingChoice;
                        pl.lifeBetBaseAmount = myMoney + myBank;
                        pl.bet = pl.lifeBetBaseAmount > 0 ? pl.lifeBetBaseAmount : 1; 
                        await supabase.from('players').update({ money: 0, bank: 0, life_bet_unlocked: false }).eq('account_id', senderId);
                        pl.pendingLifeBet = false;
                        sendTempMessage(roomId, `[info]💀 [piconname:${senderId}] が命を賭けました！[/info]`);
                        checkGameProgress(roomId);
                    } else {
                        pl.pendingLifeBet = false;
                        sendTempMessage(roomId, `[info]💨 [piconname:${senderId}] が命賭けをキャンセルしました。[/info]`);
                    }
                    return;
                }
            }

            const rsMatch = body.trim().match(/^[/#](shoot)$/);
            if (rsMatch && gambleActive && gameState[roomId]?.type === 'russian' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                
                if (pl && pl.aid === senderId) {
                    clearTimeout(g.timeoutId);
                    
                    await sendMessage(roomId, `[info]🔫 [piconname:${senderId}] がこめかみに銃口を当て、引き金を引いた……[/info]`);
                    await sleep(2000);
                    
                    if (g.currentChamber === g.bulletPos) {
                        await sendMessage(roomId, `[info]💥 ＢＡＡＡＮＧ！！！\n\n[piconname:${senderId}] は撃ち抜かれて倒れた……。[/info]`);
                        await sleep(2000);
                        
                        let winnerIdx = g.turnIndex === 0 ? 1 : 0;
                        let winner = g.players[winnerIdx];
                        let loser = pl;
                        let isReversed = false;
                        
                        if (await consumeItem(loser.aid, 'デス・リバース')) {
                            isReversed = true;
                            await sendMessage(roomId, `[info]🔄 【デス・リバース】発動！！！\n死の運命が反転し、[piconname:${loser.aid}] は [piconname:${winner.aid}] を道連れにした！！[/info]`);
                            await sleep(2000);
                        }

                        let totalPot = g.players[0].bet + g.players[1].bet;

                        if (isReversed) {
                            await addMoney(winner.aid, winner.bet);
                            await addMoney(loser.aid, loser.bet);
                            await updatePlayerStats(winner.aid, winner.bet, winner.bet, 'draw');
                            await updatePlayerStats(loser.aid, loser.bet, loser.bet, 'draw');
                            await sendMessage(roomId, `[info][title]💀 相打ち[/title]両者引き分けとなり、賭け金は返還されました。[/info]`);
                        } else {
                            await addMoney(winner.aid, totalPot);
                            await updatePlayerStats(winner.aid, winner.bet, totalPot, 'win');
                            await updatePlayerStats(loser.aid, loser.bet, 0, 'lose');
                            await updateWinStreak(winner.aid, 'win', roomId);
                            await updateWinStreak(loser.aid, 'lose', roomId);
                            
                            await supabase.from('players').update({ russian_trauma_time: Date.now() }).eq('account_id', loser.aid);
                            
                            let specMsg = "";
                            if (g.spectators && g.spectators.length > 0) {
                                specMsg = "\n[hr]【 観戦者の結果 】\n";
                                for (let spec of g.spectators) {
                                    if (spec.targetAid === winner.aid) {
                                        let winAmt = spec.bet * 2;
                                        await addMoney(spec.aid, winAmt);
                                        await updatePlayerStats(spec.aid, spec.bet, winAmt, 'win');
                                        specMsg += `[piconname:${spec.aid}]: 予想的中！ (+${formatNumber(winAmt)})\n`;
                                    } else {
                                        await updatePlayerStats(spec.aid, spec.bet, 0, 'lose');
                                        specMsg += `[piconname:${spec.aid}]: 予想はずれ (没収)\n`;
                                    }
                                }
                            }

                            await sendMessage(roomId, `[info][title]🏆 勝者: [piconname:${winner.aid}][/title]生き残った [piconname:${winner.aid}] が相手の賭け金を含めた ${formatNumber(totalPot)} コインを総取りしました！\n(※敗者は所持金を失いましたが、ブラックリストには入りません)${specMsg}[/info]`);
                        }
                        gameState[roomId] = null;
                    } else {
                        await sendMessage(roomId, `[info]カチッ……。\n\n弾は出なかった。[piconname:${senderId}] は生き延びた。[/info]`);
                        g.currentChamber = (g.currentChamber + 1) % 6;
                        g.turnIndex = g.turnIndex === 0 ? 1 : 0;
                        let nextP = g.players[g.turnIndex];
                        
                        await sleep(1500);
                        await sendTempMessage(roomId, `[info]👉 次は [piconname:${nextP.aid}] の番です。\n/#shoot を入力してください。[/info]`);
                        startGameTimer(roomId, 60000);
                    }
                }
            }

            if (body.trim().match(/^[/#](chou|han)$/) && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().replace(/^[/#]/, '');
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    checkGameProgress(roomId); 
                }
            }

            if (body.trim().match(/^[/#]roll$/) && gambleActive && gameState[roomId]?.state === 'ACTION') {
                let g = gameState[roomId];
                if (g.type === 'cc') {
                    let pl = g.players.find(x => x.aid === senderId);
                    if (pl && !pl.res) {
                        let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [piconname:${senderId}] サイコロを振っています...[/info]`)}`);
                        if (msgRes && msgRes.data) {
                            let mId = msgRes.data.message_id;
                            for(let i=0; i<8; i++) {
                                await sleep(300);
                                let tempD = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                                await editMessage(roomId, mId, `[info]🎲 [piconname:${senderId}] サイコロを振っています...\n[ ${tempD.join(', ')} ][/info]`);
                            }
                            pl.res = generateChinchiroRoll(); 
                            await editMessage(roomId, mId, `[info]🎲 [piconname:${senderId}] の出目: [ ${pl.res.dice.join(', ')} ] ➡ 『 ${pl.res.name} 』[/info]`);
                        } else {
                            pl.res = generateChinchiroRoll();
                        }
                        checkGameProgress(roomId);
                    }
                } else if (g.type === 'yacht') {
                    let pl = g.players[g.turnIndex];
                    if (pl && pl.aid === senderId && pl.status === 'playing' && pl.rolls === 0) {
                        let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [piconname:${pl.aid}] サイコロを振っています...[/info]`)}`);
                        if (msgRes && msgRes.data) {
                            let mId = msgRes.data.message_id;
                            for(let i=0; i<8; i++) {
                                await sleep(300);
                                let tempD = [...pl.dice];
                                if (!tempD || tempD.length===0) tempD = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1);
                                else tempD = tempD.map(() => Math.floor(Math.random()*6)+1);
                                await editMessage(roomId, mId, `[info]🎲 [piconname:${pl.aid}] サイコロを振っています...\n[ ${tempD.map(d=>`🎲${d}`).join(' ')} ][/info]`);
                            }
                            if (pl.futureDice) { pl.dice = pl.futureDice; delete pl.futureDice; }
                            else { pl.dice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); }
                            pl.rolls = 1;
                            await editMessage(roomId, mId, `[info]🎲 [piconname:${pl.aid}] サイコロを振りました。\n[ ${pl.dice.map(d=>`🎲${d}`).join(' ')} ][/info]`);
                        } else {
                            if (pl.futureDice) { pl.dice = pl.futureDice; delete pl.futureDice; }
                            else { pl.dice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); }
                            pl.rolls = 1;
                        }
                        await sleep(1000);
                        await proceedNextYachtTurn(roomId);
                    }
                }
            }

            if (body.match(/(^|\n)[/#]change\b/) && gambleActive && (gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    let match = body.match(/^[/#]change\s+([0-9\s]+)$/);
                    if (match) {
                        let nums = match[1].trim().split(/\s+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 5);
                        
                        if (g.type === 'poker') {
                            for (let n of nums) pl.hand[n-1] = g.deck.pop();
                            pl.status = 'stand';
                            let handStr = pl.hand.map(c => c.suit + c.rank).join(' ');
                            let ev = getPokerRank(pl.hand);
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 交換完了\n確定手札: ${handStr} (${ev.name})[/info]`);
                            g.turnIndex++; 
                            await proceedNextPokerTurn(roomId);
                        } else if (g.type === 'yacht') {
                            let cMsgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...[/info]`)}`);
                            if (cMsgRes && cMsgRes.data) {
                                let cmId = cMsgRes.data.message_id;
                                for(let i=0; i<8; i++) {
                                    await sleep(300);
                                    let tempD = [...pl.dice];
                                    let animStr = tempD.map((d, idx) => {
                                        if (nums.includes(idx + 1)) return `[ 🎲${Math.floor(Math.random() * 6) + 1} ]`;
                                        return ` 🎲${d} `; 
                                    }).join('  ');
                                    await editMessage(roomId, cmId, `[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...\n${animStr}[/info]`);
                                }

                                nums.forEach(idx => pl.dice[idx-1] = Math.floor(Math.random() * 6) + 1);
                                pl.rolls++;
                                
                                let ev = getYachtRank(pl.dice);
                                if (pl.rolls >= 3) {
                                    pl.status = 'stand';
                                    let finalDiceStr = pl.dice.map(d => `🎲${d}`).join(' ');
                                    await editMessage(roomId, cmId, `[info][piconname:${pl.aid}] 3回目の振り直し完了！\n確定サイコロ: ${finalDiceStr} (${ev.name})[/info]`);
                                    g.turnIndex++;
                                    await proceedNextYachtTurn(roomId);
                                } else {
                                    let currentDiceStr = pl.dice.map((d, i) => `[${i + 1}] 🎲${d}`).join('   ');
                                    await editMessage(roomId, cmId, `[info][title]🎲 ヨット ターン継続 ( ${pl.rolls}/3 回目 )[/title][piconname:${pl.aid}]\nサイコロ: ${currentDiceStr}\n役: ${ev.name}\n\n/#change [番号] または /#stand[/info]`);
                                    startGameTimer(roomId, 60000);
                                }
                            }
                        }
                    } else {
                        await sendTempMessage(roomId, `[info]⚠️ 番号(1〜5)を指定してください。例: /#change 1 3 5[/info]`);
                    }
                }
                return;
            }
            
            const isHitOrStand = /(^|\n)[/#]hit\b/.test(body) || /(^|\n)[/#]stand\b/.test(body);
            if (isHitOrStand && gambleActive && (gameState[roomId]?.type === 'bj' || gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (/(^|\n)[/#]hit\b/.test(body)) {
                        if (g.type !== 'bj') return;
                        
                        let c = g.deck.pop();
                        pl.hand.push(c);
                        
                        let score = calculateBJScore(pl.hand);
                        let hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        
                        if (score > 21) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else if (score === 21) {
                            pl.status = 'stand';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n\n/#hit または /#stand[/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (/(^|\n)[/#]stand\b/.test(body)) {
                        pl.status = 'stand';
                        let desc = '';
                        if (g.type === 'poker') {
                            desc = `確定手札: ${pl.hand.map(c => c.suit + c.rank).join(' ')} (${getPokerRank(pl.hand).name})`;
                        } else if (g.type === 'yacht') {
                            desc = `確定サイコロ: ${pl.dice.map(d => `🎲${d}`).join(' ')} (${getYachtRank(pl.dice).name})`;
                        } else {
                            desc = `スコア: ${calculateBJScore(pl.hand)}`;
                        }
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。\n${desc}[/info]`);
                        
                        g.turnIndex++; 
                        if (g.type === 'poker') await proceedNextPokerTurn(roomId);
                        else if (g.type === 'yacht') await proceedNextYachtTurn(roomId);
                        else await proceedNextBJTurn(roomId);
                    }
                }
            }

            const isDrawOrStand = /(^|\n)[/#]draw\b/.test(body) || /(^|\n)[/#]stand\b/.test(body);
            if (isDrawOrStand && gambleActive && gameState[roomId]?.type === 'buta' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (/(^|\n)[/#]draw\b/.test(body)) {
                        let c = g.deck.pop();
                        let prevCard = pl.hand[pl.hand.length - 1];
                        pl.hand.push(c);
                        
                        let hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        
                        if (c.suit === prevCard.suit) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n場: ${hStr}\n💥 同じマークが出ました！ドボン！[/info]`);
                            g.turnIndex++; await proceedNextButaTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🐷 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n場: ${hStr} (枚数: ${pl.hand.length})\n\n/#draw または /#stand[/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (/(^|\n)[/#]stand\b/.test(body)) {
                        pl.status = 'stand';
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。\n確定枚数: ${pl.hand.length}[/info]`);
                        g.turnIndex++; 
                        await proceedNextButaTurn(roomId);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

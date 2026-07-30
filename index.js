const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client Init ---
const chatworkClient = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States & Badges Init ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; 
const daifugoRooms = {}; 
const pachinkoSessions = {}; 
let BOT_ACCOUNT_ID = null;
let lastActiveRoomId = null;

let ownerSkill = { aid: null, expire: 0 };

const badgesFile = path.join(__dirname, 'badges.json');
if (!fs.existsSync(badgesFile)) {
    fs.writeFileSync(badgesFile, JSON.stringify({}));
}

const addBadge = (aid, badgeName, roomId = null) => {
    try {
        let badges = JSON.parse(fs.readFileSync(badgesFile, 'utf8'));
        if (!badges[aid]) badges[aid] = [];
        if (!badges[aid].includes(badgeName)) {
            badges[aid].push(badgeName);
            fs.writeFileSync(badgesFile, JSON.stringify(badges));
            if (roomId) sendMessage(roomId, `[info]🎖️ [piconname:${aid}] が新しい称号【${badgeName}】を獲得しました！[/info]`);
        }
    } catch(e) {}
};

chatworkClient.get('/me').then(res => { BOT_ACCOUNT_ID = res.data.account_id.toString(); }).catch(()=>{});

// --- 株価データ初期化 ---
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
    'ディズニー': { symbol: 'DIS', curr: 'USD' }, '日産': { symbol: '7201.T', curr: 'JPY' },
    'ベンツ': { symbol: 'MBG.DE', curr: 'EUR' }, 'アップル': { symbol: 'AAPL', curr: 'USD' },
    'ハブ': { symbol: '3030.T', curr: 'JPY' }, 'トヨタ': { symbol: '7203.T', curr: 'JPY' },
    'ソニー': { symbol: '6758.T', curr: 'JPY' }, '任天堂': { symbol: '7974.T', curr: 'JPY' },
    'マクドナルド': { symbol: 'MCD', curr: 'USD' }, 'アマゾン': { symbol: 'AMZN', curr: 'USD' },
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

// --- Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
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

// --- ランキング除外チェック ---
const isExcluded = async (aid) => {
    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
    let ex = eD ? JSON.parse(eD.value) : [];
    return ex.includes(aid.toString());
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

// --- 株価更新 ---
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

// --- アイテム・バフ処理 ---
const checkHasItem = async (aid, itemName) => {
    let { data: p } = await supabase.from('players').select('items').eq('account_id', aid).single();
    if (!p) return false;
    let items = typeof p.items === 'string' ? JSON.parse(p.items || '{}') : (p.items || {});
    return items[itemName] > 0;
};

const tryUseItem = async (aid, itemName) => {
    let { data: p } = await supabase.from('players').select('items, job_state').eq('account_id', aid).single();
    if (!p) return { success: false, msg: "" };
    
    let items = typeof p.items === 'string' ? JSON.parse(p.items || '{}') : (p.items || {});
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});

    if (!items[itemName] || items[itemName] <= 0) return { success: false, msg: `⚠️ ${itemName}を持っていません。` };
    if (js.daily_item_used) return { success: false, msg: `⚠️ 本日は既にアイテムを使用済みです。` };

    items[itemName]--;
    js.daily_item_used = true;

    if (Math.random() < 0.10) {
        await supabase.from('players').update({ items: JSON.stringify(items), job_state: JSON.stringify(js) }).eq('account_id', aid);
        return { success: false, msg: `💣 【${itemName}】を使用しようとしたが、失敗して壊れてしまった...` };
    }

    await supabase.from('players').update({ items: JSON.stringify(items), job_state: JSON.stringify(js) }).eq('account_id', aid);
    return { success: true, msg: "" };
};

const processBuffs = async (aid, isWin, isLose, isDraw, mult, resTxt) => {
    let { data: pData } = await supabase.from('players').select('job_state').eq('account_id', aid).single();
    let js = pData && typeof pData.job_state === 'string' ? JSON.parse(pData.job_state || '{}') : (pData?.job_state || {});
    let updated = false;

    // 運命のギャンブラー覚悟解放
    if (js.kakugo_active) {
        let k = js.kakugo_active;
        js.kakugo_active = 0; 
        updated = true;
        
        let probBonus = k * 0.04; // 最大0.4 (90%などに底上げする調整)
        let multBonus = 1.0 + (k * 0.9); // 最大10倍
        
        if (isLose && Math.random() < probBonus) {
            isLose = false; isWin = true; isDraw = false;
            resTxt += `🔥 【運命の書き換え】により敗北が勝利に反転！ `;
        }
        
        if (isWin) {
            mult = mult * multBonus;
            resTxt += `🔥 【覚悟の力】で配当が ${multBonus.toFixed(1)} 倍に上昇！ `;
        }
    }

    if (isLose && js.dealer_weakness_active) {
        js.dealer_weakness_active = false; updated = true;
        if (Math.random() < 0.5) {
            isLose = false; isDraw = true;
            resTxt += `😱 【弱み】発動成功！負けを無効化し引き分けにしました！ `;
        } else {
            resTxt += `😭 【弱み】発動失敗...そのまま敗北となります。 `;
        }
    }

    if (isWin && js.double_up_guess) {
        let guess = js.double_up_guess;
        js.double_up_guess = null; updated = true;
        let coinResult = Math.random() < 0.5 ? '表' : '裏';
        if (guess === coinResult) {
            mult *= 2; 
            resTxt += `🪙 ダブルアップ [${coinResult}] ➡ 予想的中！配当2倍！ `;
        } else {
            isWin = false; isLose = true; isDraw = false;
            resTxt += `🪙 ダブルアップ [${coinResult}] ➡ 予想外れ... 賭け金没収！ `;
        }
    }

    if (updated) {
        await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', aid);
    }
    
    return { isWin, isLose, isDraw, mult, resTxt };
};

const checkAndDropCat = async (aid, roomId) => {
    let { data: p } = await supabase.from('players').select('items').eq('account_id', aid).single();
    if (!p) return;
    let items = typeof p.items === 'string' ? JSON.parse(p.items || '{}') : (p.items || {});
    if (items['黄金の招き猫'] && items['黄金の招き猫'] > 0) {
        if (Math.random() < 0.005) {
            items['黄金の招き猫']--;
            await supabase.from('players').update({ items: JSON.stringify(items) }).eq('account_id', aid);
            await sendMessage(roomId, `[info]💥 ｶﾞｼｬｰﾝ!!\n\n[piconname:${aid}] は勢いあまって【黄金の招き猫】を落として割ってしまった...！[/info]`);
        }
    }
};

const updateQuest = async (aid, key, count = 1) => {
    let { data: p } = await supabase.from('players').select('job_state').eq('account_id', aid).single();
    if (!p) return;
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});
    if (!js.daily_quests) js.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
    
    if (js.daily_quests[key] !== undefined) {
        js.daily_quests[key] += count;
        await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', aid);
    }
};

const addMoney = async (accountId, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', accountId).single();
    let money = p ? (p.money || 0) : 0;
    let bank = p ? (p.bank || 0) : 0;
    money += amount;
    if (p) {
        await supabase.from('players').update({ money: money, debt: 0 }).eq('account_id', accountId);
    } else {
        await supabase.from('players').insert({ 
            account_id: accountId, money: money, bank: bank, debt: 0, 
            slot_count: 0, work_limit: 10, msg_count: 0, job: 'サラリーマン', 
            win_streak: 0, life_bet_unlocked: false, kabu_owned: 0,
            plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0, russian_trauma_time: 0,
            stocks: '{}', last_daily_date: null, login_streak: 0, daily_start_networth: 0,
            items: '{}', job_state: '{}'
        });
    }
};

const updatePlayerStats = async (accountId, betAmount, returnAmount, resultType, isTableGame = false) => {
    const { data: p } = await supabase.from('players').select('plays, wins, loses, total_bet, total_return, job_state, job').eq('account_id', accountId).single();
    if (!p) return;
    let plays = (p.plays || 0) + 1;
    let wins = p.wins || 0;
    let loses = p.loses || 0;
    
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});

    if (resultType === 'win') wins++;
    else if (resultType === 'lose') {
        loses++;
        if (p.job === '運命のギャンブラー') {
            js.kakugo = Math.min((js.kakugo || 0) + 1, 10);
        }
    }
    
    let total_bet = (p.total_bet || 0) + Math.abs(betAmount);
    let total_return = (p.total_return || 0) + Math.abs(returnAmount);
    
    if (!js.daily_stats) js.daily_stats = { bet: 0, return: 0 };
    js.daily_stats.bet += Math.abs(betAmount);
    js.daily_stats.return += Math.abs(returnAmount);

    if (resultType === 'win' && isTableGame) {
        if (!js.daily_quests) js.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
        js.daily_quests.table_win_count++;
    }

    await supabase.from('players').update({ plays, wins, loses, total_bet, total_return, job_state: JSON.stringify(js) }).eq('account_id', accountId);

    if (wins === 1) addBadge(accountId, '初勝利');
    if (wins === 10) addBadge(accountId, '駆け出しギャンブラー');
    if (wins === 100) addBadge(accountId, 'ベテランギャンブラー');
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
    if (await isExcluded(loserAid)) return;
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
    const { data: p } = await supabase.from('players').select('job, job_state').eq('account_id', aid).single();
    if (!p || p.job !== '逆転のギャンブラー') return false;
    
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});
    let currentRTP = 0;
    if (js.daily_stats && js.daily_stats.bet > 0) {
        currentRTP = (js.daily_stats.return / js.daily_stats.bet) * 100;
    }

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
    if (await isExcluded(loserAid)) return "";
    const { data: hunters } = await supabase.from('players').select('account_id, job_state').eq('job', '賞金稼ぎ');
    let bountyMsg = "";
    if (hunters) {
        for (let h of hunters) {
            let js = typeof h.job_state === 'string' ? JSON.parse(h.job_state||'{}') : (h.job_state||{});
            if (js.bounty_target === loserAid.toString() && !js.daily_bounty_used) {
                let reward = Math.floor(lostAmount * 0.1);
                if (reward > 0) {
                    await addMoney(h.account_id, reward);
                    js.daily_bounty_used = true;
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', h.account_id);
                    bountyMsg += `\n🎯 (※賞金稼ぎ [piconname:${h.account_id}] に負け金の一部 ${formatNumber(reward)} コインを奪われました)`;
                }
            }
        }
    }
    return bountyMsg;
};

const processJoker = async (winnerAid, winAmt, roomId) => {
    let stolen = 0;
    let jokerMsg = "";
    if (await isExcluded(winnerAid)) return { stolen, jokerMsg };

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
                    jokerMsg += `\n🃏 (※ジョーカー [piconname:${j.account_id}] の罠により配当から ${formatNumber(steal)} コイン横取りされました)`;
                }
            }
        }
    }
    return { stolen, jokerMsg };
};

const processButler = async (earnerAid, winAmt, roomId) => {
    if (winAmt < 1000000) return;
    if (await isExcluded(earnerAid)) return;

    const { data: allP } = await supabase.from('players').select('account_id, money, bank, kabu_owned, job');
    if (!allP) return;
    let price = kabuData.price || 1000;
    
    let eI = [];
    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
    if (eD) eI = JSON.parse(eD.value);
    
    let validP = allP.filter(p => !eI.includes(p.account_id.toString()));
    validP.sort((a,b) => ((b.money||0) + (b.bank||0) + ((b.kabu_owned||0)*price)) - ((a.money||0) + (a.bank||0) + ((a.kabu_owned||0)*price)));
    
    let top2 = validP.slice(0, 2).map(p => p.account_id.toString());
    if (top2.includes(earnerAid.toString())) {
        let reward = Math.floor(winAmt * 0.001); 
        if (reward <= 0) return;
        const butlers = validP.filter(p => p.job === '大富豪の執事' && p.account_id.toString() !== earnerAid.toString());
        for (let b of butlers) {
            await addMoney(b.account_id, reward);
            sendMessage(roomId, `[info]🎩 執事の給料\nランキング上位の主([piconname:${earnerAid}])が稼いだため、執事の [piconname:${b.account_id}] に給料 ${formatNumber(reward)} コインが支払われました。[/info]`);
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
        
        // --- 運命のギャンブラー 覚悟の解放判定 ---
        for (let p of game.players) {
            if (p.bet > 0 || p.isLifeBet) {
                let { data: pData } = await supabase.from('players').select('job, job_state').eq('account_id', p.aid).single();
                if (pData && pData.job === '運命のギャンブラー') {
                    let js = typeof pData.job_state === 'string' ? JSON.parse(pData.job_state || '{}') : (pData.job_state || {});
                    if (js.kakugo && js.kakugo > 0 && Math.random() < 0.20) {
                        js.kakugo_active = js.kakugo;
                        js.kakugo = 0;
                        await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', p.aid);
                        await sendTempMessage(roomId, `[info]🔥 [piconname:${p.aid}] の【覚悟】が限界に達し、解放された！\n次の勝負、運命が書き換わる...！(覚悟レベル: ${js.kakugo_active})[/info]`);
                    }
                }
            }
        }

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

    let buffRes = await processBuffs(player.aid, isWin, !isWin && !isDraw, isDraw, multOverride || (Math.floor(Math.random() * 8) + 8), resTxt);
    isWin = buffRes.isWin; isDraw = buffRes.isDraw;
    let mult = buffRes.mult; resTxt = buffRes.resTxt;

    if (isWin) {
        winAmt = Math.floor(betAmt * mult);
        
        let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
        let finalWin = winAmt - stolen;
        resTxt += jokerMsg;
        
        await addMoney(player.aid, finalWin);
        resTxt += `\n🎉 命賭け成功！！！ (全財産${mult.toFixed(1)}倍: +${formatNumber(finalWin)})`;
        resType = 'win';
        dealerProfit = -(winAmt - betAmt);
        
        await processButler(player.aid, winAmt, roomId);
    } else if (isDraw) {
        winAmt = betAmt;
        await addMoney(player.aid, winAmt);
        resTxt += `\n😐 引き分け (命拾い...)`;
        resType = 'draw';
        dealerProfit = 0;
    } else {
        let refunded = await processGamblerSkill(player.aid, betAmt, roomId);
        let useRes = await tryUseItem(player.aid, '身代わりの人形');

        if (refunded) {
            resTxt += `\n💀 命賭け失敗 ➡ 🔄 逆転スキルで全額返金！(出禁回避)`;
            resType = 'draw';
            winAmt = betAmt;
            dealerProfit = 0;
        } else if (useRes.success) {
            let loseAmt = Math.floor(betAmt / 2);
            await addMoney(player.aid, betAmt - loseAmt); 
            resTxt += `\n💀 命賭け失敗... だが【身代わりの人形】が身代わりとなり、追放を回避！(資産半分減少)`;
            resType = 'lose';
            dealerProfit = loseAmt;
        } else {
            await supabase.from('blacklist').insert({ account_id: player.aid });
            await updateRoomMembers(roomId, [player.aid], 'readonly');
            resTxt += `\n💀 命賭け失敗... 永久出禁処分`;
            if (useRes.msg) resTxt += `\n${useRes.msg}`;
            resType = 'lose';
            let g = gameState[roomId];
            if (g && g.type !== 'russian') {
                await processOwnerSkill(player.aid, betAmt, roomId);
                let bountyMsg = await processBounty(player.aid, betAmt, roomId);
                resTxt += bountyMsg;
            }
            dealerProfit = betAmt;
        }
    }
    
    await updatePlayerStats(player.aid, betAmt, winAmt, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, isBJ ? 2.5 : 2);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, isBJ ? 2.5 : 2, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) {
                winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                resTxt += isBJ && mult === 2.5 ? `\n(cracker) 勝利！ (BJ: 配当2.5倍) (+${formatNumber(finalWin)})` : `\n(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 負け (没収)`;
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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
        
        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, 2.0, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                resTxt += `\n(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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
        
        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, 2.0, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                resTxt += `\n(cracker) 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, 2.0, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) {
                let winAmt = Math.floor(player.bet * mult); 
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                resTxt += `\n🎉 勝利！ (+${formatNumber(finalWin)})`; 
                winAmtForStats = winAmt; resType = 'win';
                await addMoney(player.aid, finalWin); 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 負け (ドボン・没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            } 
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, r.mult > 0 ? r.mult + 1 : 1);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let bMult = r.mult > 0 ? r.mult + 1 : 1;
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, bMult, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
                totalDealerProfit += 0;
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 勝ち！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 負け ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 負け (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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
        
        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, 2.0, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 的中！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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
        let bMult = 0;
        if (player.choice === 'any' && isTriple) { isWin = true; bMult = 15; }
        else if ((player.choice === 'dai' || player.choice === 'shou') && player.choice === resultType && !isTriple) { isWin = true; bMult = 1.8; }
        
        let isLose = !isWin;
        let isDraw = false;
        let resTxt = "";
        let choiceName = player.choice === 'any' ? "ゾロ目" : (player.choice === 'dai' ? "大" : "小");

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, bMult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';

            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, bMult, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) {
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin);
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 的中！ (${mult.toFixed(1)}倍) (+${formatNumber(finalWin)})`;
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else {
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 はずれ (没収)`;
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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
        
        let bMult = getRouletteMult(player.choice);
        const { data: pD } = await supabase.from('players').select('job').eq('account_id', player.aid).single();
        if (bMult === 2 && pD && pD.job === '数学者') bMult = 2.2;

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, bMult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, bMult, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 的中！ (${mult.toFixed(1)}倍) (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, odd);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, odd, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)\n`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult); 
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 的中！ (+${formatNumber(finalWin)} コイン)\n`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 はずれ ➡ 🔄 逆転スキルで返金\n`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 はずれ (没収)\n`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, targetMult);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, targetMult, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)\n`; 
                await addMoney(player.aid, player.bet); 
                winAmtForStats = player.bet; resType = 'draw';
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 利確成功！ (${mult.toFixed(1)}x) (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 クラッシュ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 クラッシュ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

        if (player.isLifeBet) {
            let lbRes = await processLifeBetResult(player, isWin, isDraw, roomId, 2.0);
            resTxt += lbRes.msg;
            totalDealerProfit += lbRes.profit;
        } else {
            let winAmtForStats = 0; let resType = 'lose';
            
            let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, 2.0, resTxt);
            isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
            let mult = buffRes.mult; resTxt = buffRes.resTxt;

            if (isDraw) {
                if(!resTxt) resTxt += `😐 引き分け (返金)`; 
                winAmtForStats = player.bet; resType = 'draw';
                await addMoney(player.aid, player.bet); 
                totalDealerProfit += 0;
            } else if (isWin) { 
                let winAmt = Math.floor(player.bet * mult);
                
                let { stolen, jokerMsg } = await processJoker(player.aid, winAmt, roomId);
                let finalWin = winAmt - stolen;
                resTxt += jokerMsg;
                
                await addMoney(player.aid, finalWin); 
                winAmtForStats = winAmt; resType = 'win';
                resTxt += `\n(cracker) 的中！ (+${formatNumber(finalWin)})`; 
                totalDealerProfit -= (winAmt - player.bet);
                
                await processButler(player.aid, winAmt, roomId);
            } else { 
                let refunded = await processGamblerSkill(player.aid, player.bet, roomId);
                if (refunded) {
                    resTxt += `\n💀 はずれ ➡ 🔄 逆転スキルで返金`;
                    winAmtForStats = player.bet; resType = 'draw';
                } else {
                    resTxt += `\n💀 はずれ (没収)`; 
                    await processOwnerSkill(player.aid, player.bet, roomId);
                    let bountyMsg = await processBounty(player.aid, player.bet, roomId);
                    resTxt += bountyMsg;
                    totalDealerProfit += player.bet;
                }
            }
            await updatePlayerStats(player.aid, player.bet, winAmtForStats, resType, true);
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

            if (p.isLifeBet) {
                let lbRes = await processLifeBetResult(p, isWin, isDraw, roomId, defaultMult);
                resTxt += lbRes.msg;
                totalDealerProfit += lbRes.profit;
            } else {
                let winAmtForStats = 0; let resType = 'lose';
                
                let buffRes = await processBuffs(p.aid, isWin, isLose, isDraw, defaultMult, resTxt);
                isWin = buffRes.isWin; isLose = buffRes.isLose; isDraw = buffRes.isDraw;
                let mult = buffRes.mult; resTxt = buffRes.resTxt;

                if (isDraw) {
                    if(!resTxt) resTxt += `😐 引き分け (返金)\n`; 
                    await addMoney(p.aid, p.bet); 
                    winAmtForStats = p.bet; resType = 'draw';
                } else if (isWin) {
                    let winAmt = Math.floor(p.bet * mult);
                    
                    let { stolen, jokerMsg } = await processJoker(p.aid, winAmt, roomId);
                    let finalWin = winAmt - stolen;
                    resTxt += jokerMsg;
                    
                    await addMoney(p.aid, finalWin);
                    winAmtForStats = winAmt; resType = 'win';
                    resTxt += `\n(cracker) ${rName}！ (${mult.toFixed(1)}倍) (+${formatNumber(finalWin)})`;
                    totalDealerProfit -= (winAmt - p.bet);
                    
                    await processButler(p.aid, winAmt, roomId);
                } else {
                    let refunded = await processGamblerSkill(p.aid, p.bet, roomId);
                    if (refunded) {
                        resTxt += `\n💀 ${rName} ➡ 🔄 逆転スキルで返金`;
                        winAmtForStats = p.bet; resType = 'draw';
                    } else {
                        resTxt += `\n💀 ${rName}... (没収)`;
                        await processOwnerSkill(p.aid, p.bet, roomId);
                        let bountyMsg = await processBounty(p.aid, p.bet, roomId);
                        resTxt += bountyMsg;
                        totalDealerProfit += p.bet;
                    }
                }
                await updatePlayerStats(p.aid, p.bet, winAmtForStats, resType, true);
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
            // 大富豪の専用部屋アクション処理
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

            // 招き猫の破損ギミック (発言時に 0.5% で破損)
            if (gambleActive) {
                await checkAndDropCat(senderId, roomId);
            }

            // パチンコの演出スキップ
            if (body.match(/(^|\n)[/#]skip\b/) && pachinkoSessions[roomId] && pachinkoSessions[roomId].aid === senderId) {
                pachinkoSessions[roomId].isSkipped = true;
                return sendTempMessage(roomId, `[info]⏩ [piconname:${senderId}] パチンコの演出をスキップし、結果へ移行します。[/info]`);
            }

            let rankCmd = body.trim().match(/^[/#](winner-rank|rtp-rank|winrate-rank|worst-rank|daily-rank|drtp-rank|rush-rank)$/);
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
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💹 RTP: ${rtp}% (総獲得: ${formatNumber(d.total_return||0)})`;
                    }).join('\n[hr]');
                } else if (cmdType === 'winrate-rank') {
                    title = "📈 勝率ランキング TOP10 (10戦以上)";
                    f.sort((a,b) => ((b.plays||0)>0 ? (b.wins||0)/(b.plays) : 0) - ((a.plays||0)>0 ? (a.wins||0)/(a.plays) : 0));
                    s = f.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let wr = (d.plays||0)>0 ? ((d.wins||0)/(d.plays)*100).toFixed(1) : 0;
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　📈 勝率: ${wr}% (${d.wins||0}勝 / ${d.plays||0}戦)`;
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
                } else if (cmdType === 'drtp-rank') {
                    title = "💹 デイリーRTP(回収率)ランキング TOP10";
                    let activePlayers = (ls || []).filter(d => !eI.includes(d.account_id) && d.last_daily_date === today);
                    activePlayers.sort((a,b) => {
                        let aJs = typeof a.job_state === 'string' ? JSON.parse(a.job_state || '{}') : (a.job_state || {});
                        let bJs = typeof b.job_state === 'string' ? JSON.parse(b.job_state || '{}') : (b.job_state || {});
                        let aRTP = (aJs.daily_stats && aJs.daily_stats.bet > 0) ? (aJs.daily_stats.return / aJs.daily_stats.bet) : 0;
                        let bRTP = (bJs.daily_stats && bJs.daily_stats.bet > 0) ? (bJs.daily_stats.return / bJs.daily_stats.bet) : 0;
                        return bRTP - aRTP;
                    });
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let js = typeof d.job_state === 'string' ? JSON.parse(d.job_state || '{}') : (d.job_state || {});
                        let rtp = (js.daily_stats && js.daily_stats.bet > 0) ? ((js.daily_stats.return / js.daily_stats.bet) * 100).toFixed(1) : 0;
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💹 デイリーRTP: ${rtp}%`;
                    }).join('\n[hr]');
                    if (!s) s = "条件を満たすプレイヤーがいません。";
                } else if (cmdType === 'rush-rank') {
                    title = "🎰 パチンコ 最高連チャン数ランキング TOP10";
                    let allPlayers = (ls || []).filter(d => !eI.includes(d.account_id));
                    allPlayers.sort((a,b) => {
                        let aJs = typeof a.job_state === 'string' ? JSON.parse(a.job_state || '{}') : (a.job_state || {});
                        let bJs = typeof b.job_state === 'string' ? JSON.parse(b.job_state || '{}') : (b.job_state || {});
                        return (bJs.pachinko_max_streak || 0) - (aJs.pachinko_max_streak || 0);
                    });
                    let validList = allPlayers.filter(p => {
                        let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});
                        return (js.pachinko_max_streak || 0) > 0;
                    });
                    s = validList.slice(0, 10).map((d, i) => {
                        let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                        let js = typeof d.job_state === 'string' ? JSON.parse(d.job_state || '{}') : (d.job_state || {});
                        return `${md} ${i+1}位: [piconname:${d.account_id}]\n　🔥 最高連チャン: ${js.pachinko_max_streak} 回`;
                    }).join('\n[hr]');
                    if (!s) s = "連チャン記録を持つプレイヤーがいません。";
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

            // デイリーリセット処理
            if (player && player.last_daily_date !== today) {
                let diff = getDiffDays(player.last_daily_date, today);
                let streak = player.login_streak || 0;
                if (diff === 1) streak++;
                else streak = 1;

                let dailyBonus = streak * 1000;
                if (dailyBonus > 10000) dailyBonus = 10000; 

                player.money = (player.money || 0) + dailyBonus;
                player.login_streak = streak;
                
                // 1日のフラグリセット
                player.job_state.daily_item_used = false;
                player.job_state.daily_blackmarket_bought = false;
                player.job_state.daily_blackmarket_found = (Math.random() < 0.01); // 1%で闇市出現
                player.job_state.daily_stats = { bet: 0, return: 0 };
                player.job_state.daily_bounty_used = false;
                player.job_state.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
                
                let jobMsg = "";
                if (player.job_state.daily_blackmarket_found) {
                    jobMsg += `\n🕶️ 何やら怪しい路地裏を見つけた。今日なら【闇市】( /#blackmarket ) に入れるかもしれない...`;
                }

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
                    skill_date: player.skill_date,
                    job_state: JSON.stringify(player.job_state)
                }).eq('account_id', senderId);
                
                await sendTempMessage(roomId, `[info]🎁 デイリーボーナス！ (${streak}日連続ログイン)\n[piconname:${senderId}] 本日最初のアクションです。\n連続ログインボーナス ${formatNumber(dailyBonus)} コインを獲得！${jobMsg}[/info]`);
            }

            let myMoney = player ? player.money : 0;
            let myBank = player ? player.bank : 0;
            let myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';

            // トラウマチェック
            const isGameCmd = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian|crash|highlow|pachinko)\b/);
            const isJoinCmd = body.match(/(^|\n)[/#]join\b/);
            const isBetCmd = body.match(/(^|\n)[/#]bet\s+(max|half|life|[0-9.]+)/);
            if ((isGameCmd || isJoinCmd || isBetCmd) && gambleActive) {
                let remTrauma = checkTrauma(player);
                if (remTrauma > 0) {
                    return sendTempMessage(roomId, `[info]⚠️ [piconname:${senderId}]\nロシアンルーレットの恐怖で手が震え、ゲームに参加できない…\n(残り ${remTrauma} 秒)[/info]`);
                }
            }

            // --- バッジ（称号）機能 ---
            if (/(^|\n)[/#]badge\b/.test(body)) {
                let targetAid = repliedAid || senderId;
                let badges = {};
                try { badges = JSON.parse(fs.readFileSync(badgesFile, 'utf8')); } catch(e){}
                let myBadges = badges[targetAid] || [];
                let bStr = myBadges.length > 0 ? myBadges.map(b => `🎖️ ${b}`).join('\n') : "まだ称号を獲得していません。";
                return sendTempMessage(roomId, `[info][title]🎖️ [piconname:${targetAid}] の称号一覧[/title]${bStr}[/info]`);
            }

            // --- デイリークエスト機能 ---
            if (/(^|\n)[/#]quest\b/.test(body)) {
                let js = player.job_state;
                if (!js.daily_quests) js.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
                let dq = js.daily_quests;
                
                let q1 = dq.work_count >= 3;
                let q2 = dq.work_count >= 10;
                let q3 = dq.slot_count >= 1;
                let q4 = dq.slot_count >= 3;
                let q5 = dq.table_win_count >= 1;
                let q6 = dq.table_win_count >= 5;
                let q7 = dq.pachinko_spin_count >= 10;
                let q8 = dq.pachinko_reach_count >= 1;

                let completedCount = [q1,q2,q3,q4,q5,q6,q7,q8].filter(x => x).length;
                let msg = `[info][title]📜 今日のデイリークエスト[/title]`;
                msg += `[ ${q1 ? '✅' : '　'} ] 仕事を3回する (${Math.min(dq.work_count,3)}/3)\n`;
                msg += `[ ${q2 ? '✅' : '　'} ] 仕事を10回する (${Math.min(dq.work_count,10)}/10)\n`;
                msg += `[ ${q3 ? '✅' : '　'} ] スロットを1回する (${Math.min(dq.slot_count,1)}/1)\n`;
                msg += `[ ${q4 ? '✅' : '　'} ] スロットを3回する (${Math.min(dq.slot_count,3)}/3)\n`;
                msg += `[ ${q5 ? '✅' : '　'} ] テーブルGで1回勝つ (${Math.min(dq.table_win_count,1)}/1)\n`;
                msg += `[ ${q6 ? '✅' : '　'} ] テーブルGで5回勝つ (${Math.min(dq.table_win_count,5)}/5)\n`;
                msg += `[ ${q7 ? '✅' : '　'} ] パチンコで10回転 (${Math.min(dq.pachinko_spin_count,10)}/10)\n`;
                msg += `[ ${q8 ? '✅' : '　'} ] パチンコでリーチを見る (${Math.min(dq.pachinko_reach_count,1)}/1)\n`;
                msg += `[hr]🏆 クリア状況: ${completedCount} / 8 個\n\n`;

                let getMoney = 0;
                let getMsg = "";
                if (completedCount >= 3 && !dq.silver_claimed) {
                    getMoney += 10000;
                    dq.silver_claimed = true;
                    getMsg += `\n🥈 銀のデイリーボーナス (10,000 コイン) を獲得しました！`;
                    addBadge(senderId, 'クエスト見習い');
                }
                if (completedCount >= 8 && !dq.gold_claimed) {
                    getMoney += 50000;
                    dq.gold_claimed = true;
                    getMsg += `\n🥇 金のデイリーボーナス (50,000 コイン) を獲得しました！`;
                    addBadge(senderId, 'クエストマスター');
                }

                if (getMoney > 0) {
                    await addMoney(senderId, getMoney);
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', senderId);
                    msg += getMsg;
                } else {
                    if (dq.gold_claimed) msg += `本日の報酬はすべて受け取り済みです！`;
                    else msg += `3つクリアで銀(10,000)、すべてクリアで金(50,000)のボーナス！`;
                }

                return sendTempMessage(roomId, msg + `[/info]`);
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
                        if (typeof targetPlayer.job_state === 'string') targetPlayer.job_state = JSON.parse(targetPlayer.job_state || '{}');
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
                
                let js = targetPlayer.job_state || {};
                let pMaxStreak = js.pachinko_max_streak || 0;
                const pStreakStr = pMaxStreak > 0 ? `\n🎰 パチ連チャン: ${pMaxStreak} 回` : "";

                let kakugoStr = "";
                if (targetPlayer.job === '運命のギャンブラー' && js.kakugo > 0) {
                    kakugoStr = `\n🔥 蓄積した覚悟: ${js.kakugo} / 10`;
                }

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

                let targetMsg = "";
                const { data: allP } = await supabase.from('players').select('account_id, job_state');
                if (allP) {
                    for (let op of allP) {
                        let ojs = typeof op.job_state === 'string' ? JSON.parse(op.job_state||'{}') : (op.job_state||{});
                        if (ojs.bounty_target === targetAid) {
                            targetMsg += `\n🎯 誰かに賞金首として狙われている...！`;
                        }
                        if (ojs.joker_target === targetAid) {
                            targetMsg += `\n🃏 誰かにジョーカーの罠を仕掛けられている...！`;
                        }
                    }
                }

                const netWorth = calculateNetWorth(targetPlayer);
                const lastLoginStr = targetPlayer.last_daily_date ? (targetPlayer.last_daily_date === today ? "本日" : `${getDiffDays(targetPlayer.last_daily_date, today)}日前`) : "未ログイン";

                let wr = tPlays ? ((tWins / tPlays) * 100).toFixed(1) : 0;
                let rtp = tTotalBet ? ((tTotalReturn / tTotalBet) * 100).toFixed(1) : 0;
                let drtp = (js.daily_stats && js.daily_stats.bet > 0) ? ((js.daily_stats.return / js.daily_stats.bet) * 100).toFixed(1) : 0;
                const statsStr = `\n⚔️ 戦績: ${tPlays}戦 / ${tWins}勝 / ${tLoses}敗\n📈 勝率: ${wr}% / 💹 RTP: ${rtp}% / 💹 dRTP: ${drtp}%`;

                return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${targetAid}] 様 (最終ログイン: ${lastLoginStr})\n\n💰 所持金: ${formatNumber(tMoney)} コイン${bStr}${kabuStr}\n💎 純資産: ${formatNumber(netWorth)} コイン${streakStr}${pStreakStr}${statsStr}\n[hr]👔 職業: ${tJob}${kakugoStr}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${targetPlayer.work_limit || 0} 回\n⛩️ 今日の運勢: ${targetPlayer.omikuji_result || '未引'}${targetMsg}${itemStr}\n[hr]※1分後に自動消去されます[/info]`);
            }

            const cJobMatch = body.match(/(^|\n)[/#]job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|ギャンブルオーナー|未来人|逆転のギャンブラー|銀行員|大富豪の執事|賞金稼ぎ|数学者|パチプロ|運命のギャンブラー)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {
                    'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, 
                    '賭博師': 200000, 'ギャンブルオーナー': 1000000, '未来人': 5000000,
                    '逆転のギャンブラー': 1000000, '運命のギャンブラー': 1500000, '銀行員': 1000000, '大富豪の執事': 400000,
                    '賞金稼ぎ': 10000, '数学者': 50000, 'パチプロ': 50000
                };
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (/(^|\n)[/#]job\b/.test(body) && !body.match(/(^|\n)[/#]job\s+/) && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)\n ▶ /#work (400〜2000) ※10%でミス0
🏛️ 公務員 (費用: 2000)\n ▶ /#work (1200〜2000)
🚓 警察官 (費用: 3000)\n ▶ /#work (1200〜2800)
⚽ プロスポーツ選手 (費用: 5000)\n ▶ /#work (2000〜4000)
🎰 賭博師 (費用: 200,000)\n ▶ 毎日初回ログイン時にスロット回数が自動で5〜10回分増加
👑 ギャンブルオーナー (費用: 1,000,000)\n ▶ /#owner (1日1回、30分間他人のギャンブル負け金の50%を50%で回収)
👁️ 未来人 (費用: 5,000,000)\n ▶ /#next-future (1日1回、70%の確率で現在進行中のゲームの未来を予知)
🔄 逆転のギャンブラー (費用: 1,000,000)\n ▶ デイリーRTPが低いと、ギャンブルに負けた時80%の確率で賭け金が戻ってくる
🔥 運命のギャンブラー (費用: 1,500,000)\n ▶ 負けると覚悟が貯まる。ランダムで覚悟が解放され、次の勝負で配当や勝率が跳ね上がる
🏦 銀行員 (費用: 1,000,000)\n ▶ 毎日初回ログイン時に、銀行の預金に1%の複利利息が付与される
🎩 大富豪の執事 (費用: 400,000)\n ▶ ランキング1位か2位の人が稼ぐ度に、その利益の0.1%を給与として得る
🎯 賞金稼ぎ (費用: 10,000)\n ▶ /#bounty [aid] でターゲット指定。その人が次に負けた時、負け金の10%を報酬として奪う(1日1回)
🧮 数学者 (費用: 50,000)\n ▶ ルーレットの赤黒・偶数奇数等の2倍配当が「2.2倍」になる
🎰 パチプロ (費用: 50,000)\n ▶ パチンコ遊技時の釘の入賞率が 5% から 7% に上がる
[hr]※転職コマンド: /#job 役職名[/info]`);
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
                else if(myJob === '運命のギャンブラー'){ e=Math.floor(Math.random()*2001)+1000; m=`運命に抗いながら、 ${formatNumber(e)} コイン稼ぎました！🔥`; }
                else if(myJob === '銀行員'){ e=Math.floor(Math.random()*1501)+2000; m=`融資の手続きをこなし、 ${formatNumber(e)} コイン稼ぎました！🏦`; }
                else if(myJob === '大富豪の執事'){ e=Math.floor(Math.random()*1201)+800; m=`主のお世話をし、 ${formatNumber(e)} コイン稼ぎました！🎩`; }
                else if(myJob === '賞金稼ぎ'){ e=Math.floor(Math.random()*2001)+500; m=`小悪党を捕まえ、 ${formatNumber(e)} コイン稼ぎました！🎯`; }
                else if(myJob === '数学者'){ e=Math.floor(Math.random()*2001)+1500; m=`新たな公式を証明し、 ${formatNumber(e)} コイン稼ぎました！🧮`; }
                else if(myJob === 'パチプロ'){ e=Math.floor(Math.random()*1501)+500; m=`優良台のデータを取り、 ${formatNumber(e)} コイン稼ぎました！🎰`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoney(senderId, e); 
                await updateQuest(senderId, 'work_count', 1);
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }
            // --- スロットマシン ---
            const sM = body.match(/(^|\n)[/#]slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (player.slot_count >= 5) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 60000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(1分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? Math.min(myMoney, 9990000) : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                if (bet > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                if (bet < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);
                
                if (bet > 0 && myMoney >= bet) {
                    let updates = { money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() };
                    if (player.life_bet_unlocked) updates.life_bet_unlocked = false;
                    await supabase.from('players').update(updates).eq('account_id', senderId);
                    
                    await updateQuest(senderId, 'slot_count', 1);

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
                    
                    if (ml > 0) {
                        let buffRes = await processBuffs(senderId, true, false, false, ml, res);
                        ml = buffRes.mult; res = buffRes.resTxt;
                    }

                    let wA = bet * ml; 
                    if (wA > 0) {
                        let { stolen, jokerMsg } = await processJoker(senderId, wA, roomId);
                        wA -= stolen; res += jokerMsg;
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
                            let bountyMsg = await processBounty(senderId, bet, roomId);
                            res += bountyMsg;
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
                        for(let i=0; i<6; i++) {
                            await sleep(400);
                            let t1=syms[Math.floor(Math.random()*syms.length)], t2=syms[Math.floor(Math.random()*syms.length)], t3=syms[Math.floor(Math.random()*syms.length)];
                            await editMessage(roomId, mId, `[info]🎰 SLOT MACHINE 回転中...\n[ ${t1} | ${t2} | ${t3} ][/info]`);
                        }
                        await editMessage(roomId, mId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り回数: ${Math.max(0, 5 - (player.slot_count + 1))}回)[/info]`);
                    }
                } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- ゲーム募集・参加・開始 ---
            const gameCmdMatch = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|poker|yacht|sicbo|rolet|buta|daifugo|russian|highlow|crash)\b/);
            if (gameCmdMatch && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info]⚠️ 現在、別のゲームが進行中です。[/info]`);
                let t = gameCmdMatch[2]; 
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }], spectators: [] };
                let tN = t==='derby' ? "🐎 ダービー" : t==='cc' ? "🎲 チンチロリン" : t==='bj' ? "🃏 ブラックジャック" : t==='poker' ? "🃏 ポーカー" : t==='yacht' ? "🎲 ヨット" : t==='sicbo' ? "🎲 シックボー" : t==='rolet' ? "🎡 ルーレット" : t==='buta' ? "🐷 豚のしっぽ" : t==='daifugo' ? "👑 大富豪" : t==='russian' ? "🔫 ロシアンルーレット" : t==='highlow' ? "🃏 ハイロー" : t==='crash' ? "🚀 クラッシュ" : "🎲 丁半";
                if (t === 'derby') { let dO = generateDerby(); gameState[roomId].oddsMap = dO.oddsMap; gameState[roomId].oddsStr = dO.oddsStr; gameState[roomId].stats = dO.stats; }
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は /#join と入力してください！\n[hr]※ホストが /#start で開始します。[/info]`);
                startGameTimer(roomId);
                return;
            }

            if (body.match(/(^|\n)[/#]join\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) {
                    gameState[roomId].players.push({ aid: senderId, bet: 0 });
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (計 ${gameState[roomId].players.length}人)[/info]`);
                }
                return;
            }

            if (body.match(/(^|\n)[/#]start\b/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                clearTimeout(gameState[roomId].timeoutId); handleGameTimeout(roomId);
                return;
            }

            // --- ベット処理 ---
            const bM = body.match(/(^|\n)[/#]bet\s+(max|half|life|[0-9]+)(?:\s+([a-zA-Z0-9-.]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let g = gameState[roomId];
                let pl = g.players.find(x => x.aid === senderId);
                let sp = g.spectators ? g.spectators.find(x => x.aid === senderId) : null;
                if ((pl && pl.bet === 0 && !pl.pendingLifeBet) || (sp && sp.bet === 0)) {
                    let betType = bM[2];
                    if (betType === 'life') {
                        if (!player.life_bet_unlocked) return sendTempMessage(roomId, `[info]⚠️ 命を賭ける権利がありません。[/info]`);
                        pl.pendingLifeBet = true;
                        if (bM[3]) pl.pendingChoice = bM[3];
                        return sendTempMessage(roomId, `[info]💀 【命賭けの確認】\n失敗すると永久追放です。よろしければ yes と発言してください。[/info]`);
                    }
                    let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                    if (b < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);
                    if (myMoney < b) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！[/info]`);
                    
                    if (pl) {
                        pl.bet = b; if (bM[3]) pl.choice = bM[3];
                        await addMoney(senderId, -b);
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${formatNumber(b)} ベット！[/info]`);
                    } else if (sp) {
                        sp.bet = b; sp.targetAid = bM[3] || repliedAid;
                        await addMoney(senderId, -b);
                        sendTempMessage(roomId, `[info]👀 [piconname:${senderId}] が [piconname:${sp.targetAid}] に ${formatNumber(b)} 賭けました！[/info]`);
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            if ((body.trim().toLowerCase() === 'yes') && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl?.pendingLifeBet) {
                    pl.isLifeBet = true; pl.pendingLifeBet = false;
                    pl.lifeBetBaseAmount = myMoney + myBank; pl.bet = pl.lifeBetBaseAmount || 1;
                    if (pl.pendingChoice) pl.choice = pl.pendingChoice;
                    await supabase.from('players').update({ money: 0, bank: 0, life_bet_unlocked: false }).eq('account_id', senderId);
                    sendTempMessage(roomId, `[info]💀 [piconname:${senderId}] 覚悟完了。命を賭けました。[/info]`);
                    checkGameProgress(roomId);
                }
                return;
            }

            // --- アクション処理 ---
            if (body.trim().match(/^[/#]shoot$/) && gameState[roomId]?.type === 'russian' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId]; let pl = g.players[g.turnIndex];
                if (pl?.aid === senderId) {
                    clearTimeout(g.timeoutId);
                    await sendMessage(roomId, `[info]🔫 [piconname:${senderId}] が引き金を引いた...[/info]`);
                    await sleep(2000);
                    if (g.currentChamber === g.bulletPos) {
                        await sendMessage(roomId, `[info]💥 ＢＡＡＡＮＧ！！！[/info]`);
                        // デスリバース判定などは resolve ロジック内
                        g.state = 'RESOLVING'; // 簡易フラグ
                        setTimeout(() => handleGameTimeout(roomId), 100); 
                    } else {
                        await sendMessage(roomId, `[info]カチッ... (空砲)[/info]`);
                        g.currentChamber = (g.currentChamber + 1) % 6;
                        g.turnIndex = (g.turnIndex + 1) % 2;
                        startGameTimer(roomId, 60000);
                    }
                }
                return;
            }

            if (body.trim().match(/^[/#](hit|stand|draw|roll)$/) && gameState[roomId]?.state === 'ACTION') {
                // 各ゲームのターン進行ロジックへ（Part 1-3で定義済みの関数を呼び出し）
                if (body.includes('hit')) { /* BJ hit処理 */ }
                // ... (各アクションに対応)
            }

            // --- 管理者コマンド ---
            if (body.match(/^[/#]take\b/) && await isUserAdmin(roomId, senderId)) {
                let m = body.match(/[/#]take\s+([0-9]+)\s+([0-9-]+)/);
                if (m) { await addMoney(m[1], parseInt(m[2])); sendTempMessage(roomId, `[info]👑 資金操作完了[/info]`); }
                return;
            }

            if (body.match(/^[/#]fi-game\b/) && await isUserAdmin(roomId, senderId)) {
                if (gameState[roomId]) { 
                    for(let p of gameState[roomId].players) if(p.bet > 0) await addMoney(p.aid, p.bet);
                    gameState[roomId] = null; 
                    sendTempMessage(roomId, `[info]⚠️ ゲームを強制終了し返金しました。[/info]`); 
                }
                return;
            }

        } catch (error) { console.error("Webhook Error:", error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;

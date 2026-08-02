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
let BOT_ACCOUNT_ID = null;
let lastActiveRoomId = null;

let ownerSkill = { aid: null, expire: 0 };
let globalRankExcluded = []; 
const pachinkoPlayers = {}; 

const badgesFile = path.join(__dirname, 'badges.json');
if (!fs.existsSync(badgesFile)) {
    fs.writeFileSync(badgesFile, JSON.stringify({}));
}

// 称号保存バグの修正とメッセージ送信追加
const addBadge = (aid, badgeName, roomId = null) => {
    try {
        let badges = {};
        if (fs.existsSync(badgesFile)) {
            let data = fs.readFileSync(badgesFile, 'utf8');
            if (data) badges = JSON.parse(data);
        }
        if (!badges[aid]) badges[aid] = [];
        if (!badges[aid].includes(badgeName)) {
            badges[aid].push(badgeName);
            fs.writeFileSync(badgesFile, JSON.stringify(badges));
            if (roomId) sendMessage(roomId, `[info]🎖️ [piconname:${aid}] が新しい称号【${badgeName}】を獲得しました！[/info]`);
        }
    } catch(e) {
        console.error("Badge Save Error:", e);
    }
};
// 金額文字列（100, max, half）を数値に変換する共通関数
const parseAmount = (str, currentMoney) => {
    if (!str) return 0;
    if (str.toLowerCase() === 'max' || str.toLowerCase() === 'all') return currentMoney;
    if (str.toLowerCase() === 'half') return Math.floor(currentMoney / 2);
    return parseInt(str.replace(/,/g, ''), 10);
};
const formatPiconBadge = (aid, equippedBadge) => {
    return equippedBadge ? `【${equippedBadge}】[piconname:${aid}]` : `[piconname:${aid}]`;
};

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
    'ディズニー': { symbol: 'DIS', curr: 'USD' }, '日産': { symbol: '7201.T', curr: 'JPY' },
    'ベンツ': { symbol: 'MBG.DE', curr: 'EUR' }, 'アップル': { symbol: 'AAPL', curr: 'USD' },
    'ハブ': { symbol: '3030.T', curr: 'JPY' }, 'トヨタ': { symbol: '7203.T', curr: 'JPY' },
    'ソニー': { symbol: '6758.T', curr: 'JPY' }, '任天堂': { symbol: '7974.T', curr: 'JPY' },
    'マクドナルド': { symbol: 'MCD', curr: 'USD' }, 'アマゾン': { symbol: 'AMZN', curr: 'USD' },
    'KADOKAWA': { symbol: '9468.T', curr: 'JPY' }
};

let kabuData = { price: 3000, history: [3000], totalIssued: 0, lastUpdate: Date.now(), pendingProfit: 0, realStocks: {} };

supabase.from('config').select('*').in('key', ['gamble_active', 'kabu_data', 'rank_excluded']).then(r => {
    if (r.data) {
        let ga = r.data.find(x => x.key === 'gamble_active');
        if (ga) gambleActive = ga.value === 'true';
        let kd = r.data.find(x => x.key === 'kabu_data');
        if (kd) {
            let parsed = JSON.parse(kd.value);
            kabuData = { ...kabuData, ...parsed };
            if (!kabuData.realStocks) kabuData.realStocks = {};
            for (let k in realStockTickers) {
                if (!kabuData.realStocks[k]) kabuData.realStocks[k] = { price: initRealStocks[k] ? initRealStocks[k].price : 3000, totalIssued: 0 };
            }
        }
        let rEx = r.data.find(x => x.key === 'rank_excluded');
        if (rEx) { try { globalRankExcluded = JSON.parse(rEx.value); } catch(e){} }
    }
}).catch(()=>{});

// --- Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNumber = (n) => Number(n).toLocaleString();
const sleep = ms => new Promise(res => setTimeout(res, ms));
const getDiffDays = (d1Str, d2Str) => {
    if (!d1Str || !d2Str) return 0;
    return Math.floor((new Date(d2Str) - new Date(d1Str)) / 86400000);
};

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    return sig === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

const makeReplyTag = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendMessage = async (roomId, text) => {
    try { await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`); } catch(e){}
};

const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res?.data?.message_id) setTimeout(() => chatworkClient.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

const editMessage = async (roomId, messageId, text) => {
    try { await chatworkClient.put(`/rooms/${roomId}/messages/${messageId}`, `body=${encodeURIComponent(text)}`); } catch(e) {}
};

const calculateNetWorth = (p) => {
    let tMoney = p.money || 0, tBank = p.bank || 0;
    let totalStockValue = (p.kabu_owned || 0) * kabuData.price;
    if (p.stocks && kabuData.realStocks) {
        let s = JSON.parse(p.stocks);
        for (let k in s) if (kabuData.realStocks[k]) totalStockValue += s[k] * kabuData.realStocks[k].price;
    }
    return tMoney + tBank + totalStockValue;
};

// --- ビンゴ処理 ---
let bingoExecutedDate = null;
setInterval(async () => {
    let now = new Date(Date.now() + 32400000);
    let dateStr = now.toISOString().split('T')[0];
    supabase.from('config').select('*').eq('key', 'rank_excluded').then(r => {
        if (r.data && r.data[0]) { try { globalRankExcluded = JSON.parse(r.data[0].value); } catch(e){} }
    }).catch(()=>{});

    if (now.getDay() === 5 && now.getHours() >= 20 && now.getHours() < 23) {
        if (bingoExecutedDate !== dateStr && now.getHours() === 21 && now.getMinutes() === 0) {
            bingoExecutedDate = dateStr;
            const { data: activePlayers } = await supabase.from('players').select('account_id').eq('last_daily_date', dateStr);
            if (activePlayers && activePlayers.length > 0) {
                let winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];
                let prize = Math.floor(Math.random() * 2000000) + 1000000;
                await addMoney(winner.account_id, prize);
                if (lastActiveRoomId) sendMessage(lastActiveRoomId, `[info][title]🎉 金曜夜のビンゴ大会！[/title]今週のラッキーユーザーは... [piconname:${winner.account_id}] さんです！\n見事ビンゴし、賞金 ${formatNumber(prize)} コインを獲得しました！[/info]`);
            }
        }
    }
}, 60000);

// --- 株価更新 ---
const fetchExchangeRates = async () => { /* 略: 既存通り */ return { usd: 150, eur: 160 }; };
const fetchStockData = async (tickerInfo, range = '1d') => { /* 略: 既存通り */ return null; };

const updateKabuPrice = async () => {
    let now = Date.now(), hoursPassed = Math.floor((now - kabuData.lastUpdate) / 3600000);
    if (hoursPassed > 0) {
        for (let i = 0; i < hoursPassed; i++) {
            let changePercent = i === 0 ? ((kabuData.pendingProfit || 0) / 500000) * 0.05 : 0;
            if (i === 0) kabuData.pendingProfit = 0;
            changePercent += (Math.random() * 0.04) - 0.02;
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

// --- アイテム & バフ ---
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

    items[itemName]--; js.daily_item_used = true;

    if (Math.random() < 0.10) {
        await supabase.from('players').update({ items: JSON.stringify(items), job_state: JSON.stringify(js) }).eq('account_id', aid);
        return { success: false, msg: `💣 【${itemName}】を使用しようとしたが、失敗して壊れてしまった...` };
    }
    await supabase.from('players').update({ items: JSON.stringify(items), job_state: JSON.stringify(js) }).eq('account_id', aid);
    return { success: true, msg: "" };
};

const processBuffs = async (aid, isWin, isLose, isDraw, mult, resTxt) => {
    let { data: pData } = await supabase.from('players').select('job_state, job').eq('account_id', aid).single();
    let js = pData && typeof pData.job_state === 'string' ? JSON.parse(pData.job_state || '{}') : (pData?.job_state || {});
    let updated = false;

    if (isLose && js.dealer_weakness_active) {
        js.dealer_weakness_active = false; updated = true;
        if (Math.random() < 0.5) {
            isLose = false; isDraw = true; resTxt += `😱 【弱み】発動成功！負けを無効化し引き分けにしました！ `;
        } else resTxt += `😭 【弱み】発動失敗...そのまま敗北となります。 `;
    }

    if (isWin && js.double_up_guess) {
        let guess = js.double_up_guess; js.double_up_guess = null; updated = true;
        let coinResult = Math.random() < 0.5 ? '表' : '裏';
        if (guess === coinResult) { mult *= 2; resTxt += `🪙 ダブルアップ [${coinResult}] ➡ 予想的中！配当2倍！ `; } 
        else { isWin = false; isLose = true; isDraw = false; resTxt += `🪙 ダブルアップ [${coinResult}] ➡ 予想外れ... 賭け金没収！ `; }
    }

    if (updated) await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', aid);
    return { isWin, isLose, isDraw, mult, resTxt };
};

const checkAndDropCat = async (aid, roomId) => {
    let { data: p } = await supabase.from('players').select('items').eq('account_id', aid).single();
    if (!p) return;
    let items = typeof p.items === 'string' ? JSON.parse(p.items || '{}') : (p.items || {});
    if (items['黄金の招き猫'] && items['黄金の招き猫'] > 0 && Math.random() < 0.005) {
        items['黄金の招き猫']--;
        await supabase.from('players').update({ items: JSON.stringify(items) }).eq('account_id', aid);
        await sendMessage(roomId, `[info]💥 ｶﾞｼｬｰﾝ!!\n\n[piconname:${aid}] は勢いあまって【黄金の招き猫】を落として割ってしまった...！[/info]`);
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
    let money = p ? (p.money || 0) + amount : amount;
    if (p) {
        await supabase.from('players').update({ money: money, debt: 0 }).eq('account_id', accountId);
    } else {
        await supabase.from('players').insert({ 
            account_id: accountId, money: money, bank: 0, debt: 0, slot_count: 0, work_limit: 10, msg_count: 0, 
            job: 'サラリーマン', win_streak: 0, kabu_owned: 0, plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0, 
            russian_trauma_time: 0, stocks: '{}', login_streak: 0, items: '{}', job_state: '{}'
        });
    }
};

const updatePlayerStats = async (accountId, betAmount, returnAmount, resultType, isTableGame = false) => {
    const { data: p } = await supabase.from('players').select('plays, wins, loses, total_bet, total_return, job_state, job').eq('account_id', accountId).single();
    if (!p) return;
    let plays = (p.plays || 0) + 1;
    let wins = p.wins || 0, loses = p.loses || 0;
    if (resultType === 'win') wins++; else if (resultType === 'lose') loses++;
    
    let total_bet = (p.total_bet || 0) + Math.abs(betAmount);
    let total_return = (p.total_return || 0) + Math.abs(returnAmount);
    
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});
    if (!js.daily_stats) js.daily_stats = { bet: 0, return: 0 };
    js.daily_stats.bet += Math.abs(betAmount); js.daily_stats.return += Math.abs(returnAmount);

    if (resultType === 'win' && isTableGame) {
        if (!js.daily_quests) js.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
        js.daily_quests.table_win_count++;
    }

    await supabase.from('players').update({ plays, wins, loses, total_bet, total_return, job_state: JSON.stringify(js) }).eq('account_id', accountId);

    if (wins === 1) addBadge(accountId, '初勝利', lastActiveRoomId);
    if (wins === 10) addBadge(accountId, '駆け出しギャンブラー', lastActiveRoomId);
    if (wins === 100) addBadge(accountId, 'ベテランギャンブラー', lastActiveRoomId);
};

const updateWinStreak = async (accountId, result, roomId) => {
    if (result === 'draw') return;
    const { data: p } = await supabase.from('players').select('win_streak').eq('account_id', accountId).single();
    if (!p) return;
    let streak = p.win_streak || 0;
    if (result === 'win') {
        streak++;
        await supabase.from('players').update({ win_streak: streak }).eq('account_id', accountId);
    } else if (result === 'lose') {
        await supabase.from('players').update({ win_streak: 0 }).eq('account_id', accountId);
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

// --- スキル処理 ---
const processOwnerSkill = async (loserAid, lostAmount, roomId) => {
    if (globalRankExcluded.includes(ownerSkill.aid) || globalRankExcluded.includes(loserAid.toString())) return;
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
    let currentRTP = js.daily_stats && js.daily_stats.bet > 0 ? (js.daily_stats.return / js.daily_stats.bet) * 100 : 0;
    let threshold = Math.floor(Math.random() * 21) + 30; // 30〜50

    if (currentRTP <= threshold && Math.random() < 0.8) {
        await addMoney(aid, lostAmount);
        await updatePlayerStats(aid, 0, lostAmount, 'draw'); 
        sendMessage(roomId, `[info]🔄 逆転のギャンブラー発動！\n[piconname:${aid}] 崖っぷちの運命が覆り、負け金 ${formatNumber(lostAmount)} コインが返還されました！[/info]`);
        return true;
    }
    return false;
};

const processBounty = async (loserAid, lostAmount, roomId) => {
    let bountyMsg = "";
    if (globalRankExcluded.includes(loserAid.toString())) return bountyMsg;
    const { data: hunters } = await supabase.from('players').select('account_id, job_state').eq('job', '賞金稼ぎ');
    if (hunters) {
        for (let h of hunters) {
            if (globalRankExcluded.includes(h.account_id.toString())) continue;
            let js = typeof h.job_state === 'string' ? JSON.parse(h.job_state||'{}') : (h.job_state||{});
            if (js.bounty_target === loserAid.toString() && !js.daily_bounty_used) {
                let reward = Math.floor(lostAmount * 0.1);
                if (reward > 0) {
                    await addMoney(h.account_id, reward);
                    js.daily_bounty_used = true;
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', h.account_id);
                    bountyMsg += `\n🎯 (※賞金稼ぎ [piconname:${h.account_id}] に負け金の10% ${formatNumber(reward)} コインを奪われました)`;
                }
            }
        }
    }
    return bountyMsg;
};

const processJoker = async (winnerAid, winAmt, roomId) => {
    let stolen = 0, jokerMsg = "";
    if (globalRankExcluded.includes(winnerAid.toString())) return { stolen, jokerMsg };
    const { data: jokers } = await supabase.from('players').select('account_id, job_state');
    if (jokers) {
        for (let j of jokers) {
            if (globalRankExcluded.includes(j.account_id.toString())) continue;
            let js = typeof j.job_state === 'string' ? JSON.parse(j.job_state||'{}') : (j.job_state||{});
            if (js.joker_target === winnerAid.toString()) {
                let pct = (Math.floor(Math.random() * 11) + 10) / 100;
                let steal = Math.floor(winAmt * pct);
                if (steal > 0) {
                    await addMoney(j.account_id, steal); stolen += steal; js.joker_target = null;
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', j.account_id);
                    jokerMsg += `\n🃏 (※ジョーカー [piconname:${j.account_id}] の罠により配当から ${formatNumber(steal)} コイン横取りされました)`;
                }
            }
        }
    }
    return { stolen, jokerMsg };
};

const processButler = async (earnerAid, winAmt, roomId) => {
    if (winAmt < 1000000 || globalRankExcluded.includes(earnerAid.toString())) return;
    const { data: allP } = await supabase.from('players').select('account_id, money, bank, kabu_owned, job');
    if (!allP) return;
    let price = kabuData.price || 1000;
    let filtered = allP.filter(x => !globalRankExcluded.includes(x.account_id.toString()));
    filtered.sort((a,b) => ((b.money||0) + (b.bank||0) + ((b.kabu_owned||0)*price)) - ((a.money||0) + (a.bank||0) + ((a.kabu_owned||0)*price)));
    
    let top2 = filtered.slice(0, 2).map(p => p.account_id.toString());
    if (top2.includes(earnerAid.toString())) {
        let reward = Math.floor(winAmt * 0.001); 
        if (reward <= 0) return;
        const butlers = filtered.filter(p => p.job === '大富豪の執事' && p.account_id.toString() !== earnerAid.toString());
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
    let stats = []; for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
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

// 5枚役判定
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

// 7枚から最強の5枚を選ぶ (テキサスホールデム用)
const getBestTexasRank = (hand7) => {
    let bestEv = { rank: -1 };
    const getCombinations = (arr, k) => {
        let i, j, combs, head, tailcombs;
        if (k > arr.length || k <= 0) { return []; }
        if (k === arr.length) { return [arr]; }
        if (k === 1) { combs = []; for (i = 0; i < arr.length; i++) { combs.push([arr[i]]); } return combs; }
        combs = [];
        for (i = 0; i < arr.length - k + 1; i++) {
            head = arr.slice(i, i + 1);
            tailcombs = getCombinations(arr.slice(i + 1), k - 1);
            for (j = 0; j < tailcombs.length; j++) { combs.push(head.concat(tailcombs[j])); }
        }
        return combs;
    };
    let combs = getCombinations(hand7, 5);
    for (let c of combs) {
        let ev = getPokerRank(c);
        if (bestEv.rank === -1 || comparePoker(ev, bestEv) > 0) bestEv = ev;
    }
    return bestEv;
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

                let specTxt = game.spectators.length > 0 ? `\n👀 観戦者(${game.spectators.length}名)の方は /#bet [額] [aid] で勝者を予想してください！` : ``;
                let pTxt = `🔫 プレイヤー:\n1. [piconname:${game.players[0].aid}]\n2. [piconname:${game.players[1].aid}]`;
                
                await sendTempMessage(roomId, `[info][title]🔫 ロシアンルーレット ベット開始[/title]抽選でプレイヤーが確定しました。\n\n${pTxt}\n\nプレイヤーは /#bet [額] を入力してください。(※相手の全財産の半分未満)\n${specTxt}\n[hr](制限1分)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]/#bet [額] [馬1]-[馬2] (例: /#bet 100 1-2)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else if (game.type === 'crash') {
                let ex = `/#bet [額] [目標倍率(1.01以上)] (例: /#bet 100 2.5)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'highlow') {
                let ex = `/#bet [額] high か /#bet [額] low`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'sicbo') {
                let ex = `/#bet [額] dai か /#bet [額] shou か /#bet [額] any`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。)[/info]`);
                startGameTimer(roomId, 60000);
            } else if (game.type === 'rolet') {
                let ex = `/#bet [額] [予想] (red/black/even/odd/high/low/数字)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。)[/info]`);
                startGameTimer(roomId, 60000);
            } else {
                let ex = `/#bet [額] または /#bet max でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が規定人数未満のため、ゲームを中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else if (game.state === 'BETTING') {
        let kickedAids = [], activePlayers = [];
        for (let player of game.players) {
            if (player.bet === 0) kickedAids.push(player.aid);
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
            await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、未ベットのユーザーを退出させました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        }
        
        let isEnoughPlayers = game.type === 'russian' ? (game.players.length >= 2) : (game.players.length >= 1);
        if (!isEnoughPlayers) {
            for (let player of game.players) {
                if (player.bet > 0) await addMoney(player.aid, player.bet); 
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
        if (['bj', 'texas', 'yacht', 'buta', 'daifugo'].includes(game.type)) {
            let player = game.players[game.turnIndex];
            if (player && player.status === 'playing') {
                if (game.type === 'daifugo') {
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は強制パスしました。[/info]`);
                    game.daifugo.passCount++;
                    await checkDaifugoNextTurn(roomId);
                } else if (game.type === 'texas') {
                    player.status = 'fold';
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は自動フォールド(降り)しました。[/info]`);
                    game.turnIndex++;
                    await proceedNextTexasTurn(roomId);
                } else {
                    player.status = 'stand';
                    await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は自動スタンドしました。[/info]`);
                    game.turnIndex++;
                    if (game.type === 'yacht') await proceedNextYachtTurn(roomId);
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
                    await supabase.from('players').update({ win_streak: 0 }).eq('account_id', player.aid);
                    if (player.bet > 0) await processOwnerSkill(player.aid, player.bet, roomId);
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
    
    let allPlayersBet = game.players.every(p => p.bet > 0);
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
                
                // 隻眼スキルの適用チェック
                let hStr = "";
                if (p.isOneEyeActive) {
                    hStr = `${p.hand[0].suit}${p.hand[0].rank} / [？]`;
                } else {
                    hStr = p.hand.map(c => c.suit + c.rank).join(' ');
                }

                const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                let b = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
                p.eqBadge = b;

                msg += `${formatPiconBadge(p.aid, b)}: ${hStr} (スコア: ${p.isOneEyeActive ? '??' : pScore})`;
                if (pScore === 21) { p.status = 'bj'; msg += ` 🎉 ブラックジャック！\n`; } 
                else { p.status = 'playing'; msg += `\n`; }
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextBJTurn(roomId);
        } else if (game.type === 'texas') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            
            game.communityCards = [];
            for (let i=0; i<5; i++) game.communityCards.push(game.deck.pop());
            game.dealerHand = [game.deck.pop(), game.deck.pop()];

            let commStr = game.communityCards.map(c => c.suit + c.rank).join('   ');

            let msg = `[info][title]🃏 テキサスホールデム 開始[/title]全員ベット完了！\n\n【 🌐 コミュニティカード (共通) 】\n${commStr}\n\n[hr]【 各プレイヤーの手札(2枚) 】\n`;
            for (let p of game.players) {
                p.hand = [game.deck.pop(), game.deck.pop()];
                p.status = 'playing';
                const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                p.eqBadge = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
            }
            msg += `\n順番に 勝負(stand) か 降りる(fold) かを選択します。[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextTexasTurn(roomId);

        } else if (game.type === 'yacht') {
            game.state = 'ACTION';
            for (let p of game.players) { 
                p.dice = []; p.status = 'playing'; p.rolls = 0; 
                const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                p.eqBadge = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
            }
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
                const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                p.eqBadge = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
                
                let hStr = p.hand.map(c => c.suit + c.rank).join(' ');
                msg += `${formatPiconBadge(p.aid, p.eqBadge)}: ${hStr} (枚数: 1)\n`;
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
                    const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                    p.eqBadge = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
                    
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
            for (let p of game.players) {
                const { data: psData } = await supabase.from('players').select('job_state').eq('account_id', p.aid).single();
                p.eqBadge = psData?.job_state ? JSON.parse(psData.job_state||'{}').equipped_badge : null;
            }
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
        
        let hStr = "";
        if (player.isOneEyeActive) {
            hStr = `${player.hand[0].suit}${player.hand[0].rank} / [？]`;
            score = "??"; // 隻眼スキル発動中
        } else {
            hStr = player.hand.map(c => c.suit + c.rank).join(' ');
        }

        await sendTempMessage(roomId, `[info][title]🃏 ターン進行[/title][piconname:${player.aid}] さんの番です！\n手札: ${hStr} (スコア: ${score})\n\n/#hit (引く) または /#stand (引かない) を入力してください。\n(制限1分)[/info]`);
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

// --- テキサスホールデム 進行 ---
const proceedNextTexasTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'texas') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let handStr = player.hand.map(c => c.suit + c.rank).join('   ');
        
        let bestEv = getBestTexasRank([...game.communityCards, ...player.hand]);

        await sendTempMessage(roomId, `[info][title]🃏 テキサスホールデム ターン進行[/title][piconname:${player.aid}] さんの番です！\n\n【 あなたの手札 】\n${handStr}\n\n(現在の最強役: ${bestEv.name})\n\n勝負するなら /#stand\n降りるなら /#fold\nを入力してください。(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await proceedBotTexasTurn(roomId);
};

const proceedBotTexasTurn = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;

    await sendMessage(roomId, `[info][ディーラー] のターンです。\n手札を確認中...[/info]`);
    await sleep(2500);
    
    // ボットは常に勝負（stand）とする
    await sendMessage(roomId, `/#stand`);
    await sleep(1000);
    await sendMessage(roomId, `[info][ディーラー] 勝負します。[/info]`);
    
    await sleep(2000);
    await resolveTexas(roomId);
};

// --- ヨット進行 ---
const proceedNextYachtTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'yacht') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        if (player.rolls === 0) {
            await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン開始[/title][piconname:${player.aid}] さんの番です！\n/#roll を入力して最初のサイコロを振ってください。\n(制限1分)[/info]`);
        } else {
            let diceStr = "";
            if (player.isOneEyeActive && player.rolls === 1) {
                // 隻眼スキル：最初のロール時、5個中3個が「？」になる
                diceStr = `[1] 🎲${player.dice[0]}   [2] 🎲${player.dice[1]}   [3] 🎲？   [4] 🎲？   [5] 🎲？`;
            } else {
                diceStr = player.dice.map((d, i) => `[${i+1}] 🎲${d}`).join('   ');
            }
            
            let ev = player.isOneEyeActive && player.rolls === 1 ? {name:"？(見えない)"} : getYachtRank(player.dice);

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

const processTenbin = async (aid, isWin) => {
    let { data: p } = await supabase.from('players').select('job, job_state').eq('account_id', aid).single();
    if (!p || p.job !== 'てんびん') return { isWin, msg: "" };
    let js = typeof p.job_state === 'string' ? JSON.parse(p.job_state || '{}') : (p.job_state || {});

    if (js.tenbin_active) {
        js.tenbin_active = false;
        await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', aid);
        
        let rand = Math.random();
        // 10%で逆に傾く（強制敗北）
        if (rand < 0.10) {
            return { isWin: false, msg: "\n⚖️ 【天秤】の呪い... 不運へ傾き強制敗北となった。" };
        }
        
        // 元々負けの場合、10%〜30%の確率で強制勝利に書き換える
        if (!isWin) {
            let winChance = 0.10 + (Math.random() * 0.20); // 10%〜30%
            if (Math.random() < winChance) {
                return { isWin: true, msg: "\n⚖️ 【天秤】の加護！ 幸運へ傾き、敗北の運命を勝利へ捻じ曲げた！" };
            } else {
                return { isWin: false, msg: "\n⚖️ 【天秤】を使用したものの、運命は覆らなかった..." };
            }
        } else {
            return { isWin: true, msg: "\n⚖️ 【天秤】は見事幸運を維持した！" };
        }
    }
    return { isWin, msg: "" };
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

        let winAmtForStats = 0; let resType = 'lose';
        
        let baseMult = isBJ ? 2.5 : 2;
        // 隻眼スキルの配当アップ
        if (player.isOneEyeActive) { baseMult = 3; resTxt += `\n👁️ 【隻眼】発動により配当3倍！`; }

        let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, baseMult, resTxt);
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
        
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);
        
        // 隻眼だった場合の手札公開
        let hStr = player.hand.map(c => c.suit + c.rank).join(' ');
        msg += `[piconname:${player.aid}]: [${hStr}] スコア ${pScore} ➡ ${resTxt}\n`;
    }
    kabuData.pendingProfit = (kabuData.pendingProfit || 0) + totalDealerProfit;
    await supabase.from('config').upsert({ key: 'kabu_data', value: JSON.stringify(kabuData) });
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveTexas = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let commStr = game.communityCards.map(c => c.suit + c.rank).join(' ');
    let botEv = getBestTexasRank([...game.communityCards, ...game.dealerHand]);
    let botStr = game.dealerHand.map(c => c.suit + c.rank).join(' ');
    
    let msg = `[info][title]🃏 テキサスホールデム 最終結果[/title]【 ディーラー 】\n手札: ${botStr}\n(共通: ${commStr})\n役: ${botEv.name}\n[hr]【 プレイヤー結果 】\n`;
    
    let totalDealerProfit = 0;

    for (let player of game.players) {
        let resTxt = "";
        let pStr = player.hand.map(c => c.suit + c.rank).join(' ');

        if (player.status === 'fold') {
            resTxt = `💀 フォールド (降り) による没収`;
            await processOwnerSkill(player.aid, player.bet, roomId);
            resTxt += await processBounty(player.aid, player.bet, roomId);
            totalDealerProfit += player.bet;
            await updatePlayerStats(player.aid, player.bet, 0, 'lose', true);
            await updateWinStreak(player.aid, 'lose', roomId);
            msg += `[piconname:${player.aid}]: 手札 ${pStr} ➡ ${resTxt}\n`;
            continue;
        }

        let pEv = getBestTexasRank([...game.communityCards, ...player.hand]);
        let comp = comparePoker(pEv, botEv);
        let isWin = comp > 0, isDraw = comp === 0, isLose = comp < 0;
        
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
        
        if (isWin) await updateWinStreak(player.aid, 'win', roomId);
        else if (isLose && !resTxt.includes('返金')) await updateWinStreak(player.aid, 'lose', roomId);

        msg += `[piconname:${player.aid}]: 手札 ${pStr} (${pEv.name})\n➡ ${resTxt}\n`;
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
        let winAmtForStats = 0; let resType = 'lose';
        
        let baseMult = 2.0;
        if (player.isOneEyeActive) {
            baseMult = 3.0;
            resTxt += `\n👁️ 【隻眼】発動により配当3倍！`;
        }
        
        let buffRes = await processBuffs(player.aid, isWin, isLose, isDraw, baseMult, resTxt);
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
        
        // 天秤の判定
        if (game.players.length >= 2) {
            let tbRes = await processTenbin(player.aid, isWin);
            isWin = tbRes.isWin;
            isLose = !isWin;
            resTxt += tbRes.msg;
        }

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

        // 天秤の判定
        if (game.players.length >= 2 && ['dai', 'shou'].includes(player.choice)) {
            let tbRes = await processTenbin(player.aid, isWin);
            isWin = tbRes.isWin;
            isLose = !isWin;
            resTxt += tbRes.msg;
        }

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
            resTxt += `\n(cracker) 的中！ (${mult}倍) (+${formatNumber(finalWin)})`;
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
        if (bMult === 2 && pD && pD.job === '数学者') bMult = 2.1;

        // 天秤の判定 (赤黒、偶数奇数、ハイローなど2択ベット時)
        if (game.players.length >= 2 && ['red','black','even','odd','high','low'].includes(player.choice)) {
            let tbRes = await processTenbin(player.aid, isWin);
            isWin = tbRes.isWin;
            isLose = !isWin;
            resTxt += tbRes.msg;
        }

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
            resTxt += `\n(cracker) 的中！ (${mult}倍) (+${formatNumber(finalWin)})`; 
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
            resTxt += `\n(cracker) 利確成功！ (${mult}x) (+${formatNumber(finalWin)})`; 
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
        
        // 天秤の判定
        if (game.players.length >= 2) {
            let tbRes = await processTenbin(player.aid, isWin);
            isWin = tbRes.isWin;
            isLose = !isWin;
            resTxt += tbRes.msg;
        }

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
                resTxt += `\n(cracker) ${rName}！ (${mult}倍) (+${formatNumber(finalWin)})`;
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

            if (gambleActive) {
                await checkAndDropCat(senderId, roomId);
            }
            // --- バッジ（称号）機能 ---
            if (/(^|\n)[/#]badgeuse\b/.test(body)) {
                let tgtBdg = (body.match(/(^|\n)[/#]badgeuse\s+(.+)/) || [])[2];
                let js = player.job_state;
                if (!tgtBdg) {
                    js.equipped_badge = null;
                    await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info]🏷️ 装備称号を外しました。[/info]`);
                }
                tgtBdg = tgtBdg.trim();
                let badges = {}; try { badges = JSON.parse(fs.readFileSync(badgesFile, 'utf8')); } catch(e){}
                let myBadges = badges[senderId] || [];
                if (!myBadges.includes(tgtBdg)) return sendTempMessage(roomId, `[info]⚠️ その称号を持っていません。\n /#badge で所持一覧を確認できます。[/info]`);
                js.equipped_badge = tgtBdg;
                await supabase.from('players').update({ job_state: JSON.stringify(js) }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info]🎖️ ${formatPiconBadge(senderId, tgtBdg)}\n称号を装備しました！[/info]`);
            }

            if (/(^|\n)[/#]badge\b/.test(body) && !/(^|\n)[/#]badgeuse\b/.test(body)) {
                let targetAid = repliedAid || senderId;
                let badges = {};
                try { badges = JSON.parse(fs.readFileSync(badgesFile, 'utf8')); } catch(e){}
                let myBadges = badges[targetAid] || [];
                let bStr = myBadges.length > 0 ? myBadges.map(b => `🎖️ ${b}`).join('\n') : "まだ称号を獲得していません。";
                return sendTempMessage(roomId, `[info][title]🎖️ [piconname:${targetAid}] の称号一覧[/title]${bStr}[/info]`);
            }

            // --- ランキング機能 ---
            let rankCmd = body.trim().match(/^[/#](money-rank|winner-rank|rtp-rank|winrate-rank|worst-rank|daily-rank|drtp-rank)$/);
            if (rankCmd) {
                let cmdType = rankCmd[1];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !globalRankExcluded.includes(d.account_id)) : [];
                let title = "", s = "";
                let price = kabuData.price || 1000;
                
                const mapRankBadge = (d, idx, subTxt, badgeBase) => {
                    if (idx === 0) addBadge(d.account_id, badgeBase + ' 金', null);
                    else if (idx === 1) addBadge(d.account_id, badgeBase + ' 銀', null);
                    else if (idx === 2) addBadge(d.account_id, badgeBase + ' 銅', null);
                    let md = idx===0 ? "🥇" : (idx===1 ? "🥈" : (idx===2 ? "🥉" : "🔹")); 
                    let lg = d.last_daily_date ? (d.last_daily_date === today ? "本日" : `${getDiffDays(d.last_daily_date, today)}日前`) : "未ログイン";
                    let dEqBadge = d.job_state ? (typeof d.job_state === 'string' ? JSON.parse(d.job_state).equipped_badge : d.job_state.equipped_badge) : null;
                    return `${md} ${idx+1}位: ${formatPiconBadge(d.account_id, dEqBadge)} (最終: ${lg})\n　${subTxt}`;
                };

                if (cmdType === 'money-rank') {
                    title = "👑 純資産ランキング TOP10";
                    f.sort((a,b) => ((b.money||0)+(b.bank||0)+((b.kabu_owned||0)*price)) - ((a.money||0)+(a.bank||0)+((a.kabu_owned||0)*price)));
                    s = f.slice(0, 10).map((d, i) => mapRankBadge(d, i, `💎 純資産: ${formatNumber((d.money||0)+(d.bank||0)+((d.kabu_owned||0)*price))} コイン [${d.job||'サラリーマン'}]`, "純資産ランカー")).join('\n[hr]');
                } else if (cmdType === 'winner-rank') {
                    title = "🏆 勝利数ランキング TOP10 (10戦以上)";
                    f = f.filter(d => (d.plays||0)>=10).sort((a,b) => (b.wins||0) - (a.wins||0));
                    s = f.slice(0, 10).map((d, i) => mapRankBadge(d, i, `🏆 勝利数: ${d.wins||0}回 (勝率: ${((d.wins||0)/(d.plays)*100).toFixed(1)}%)`, "勝利数ランカー")).join('\n[hr]');
                } else if (cmdType === 'rtp-rank') {
                    title = "💹 RTP(回収率)ランキング TOP10 (10戦以上)";
                    f = f.filter(d => (d.plays||0)>=10).sort((a,b) => ((b.total_bet||0)>0 ? (b.total_return||0)/(b.total_bet) : 0) - ((a.total_bet||0)>0 ? (a.total_return||0)/(a.total_bet) : 0));
                    s = f.slice(0, 10).map((d, i) => {
                        let rtp = (d.total_bet||0)>0 ? ((d.total_return||0)/(d.total_bet)*100).toFixed(1) : 0;
                        return mapRankBadge(d, i, `💹 RTP: ${rtp}% (総獲得: ${formatNumber(d.total_return||0)})`, "RTPランカー");
                    }).join('\n[hr]');
                } else if (cmdType === 'winrate-rank') {
                    title = "📈 勝率ランキング TOP10 (10戦以上)";
                    f = f.filter(d => (d.plays||0)>=10).sort((a,b) => ((b.plays||0)>0 ? (b.wins||0)/(b.plays) : 0) - ((a.plays||0)>0 ? (a.wins||0)/(a.plays) : 0));
                    s = f.slice(0, 10).map((d, i) => {
                        let wr = ((d.wins||0)/(d.plays)*100).toFixed(1);
                        return mapRankBadge(d, i, `📈 勝率: ${wr}% (${d.wins||0}勝 / ${d.plays||0}戦)`, "高勝率ランカー");
                    }).join('\n[hr]');
                } else if (cmdType === 'worst-rank') {
                    title = "💸 ワーストランキング TOP10 (直近3日以内)";
                    let activePlayers = f.filter(d => d.last_daily_date && getDiffDays(d.last_daily_date, today) <= 3);
                    activePlayers.sort((a,b) => calculateNetWorth(a) - calculateNetWorth(b));
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        if (i === 0) addBadge(d.account_id, 'ワースト 金', null);
                        else if (i === 1) addBadge(d.account_id, 'ワースト 銀', null);
                        else if (i === 2) addBadge(d.account_id, 'ワースト 銅', null);
                        let md = i===0 ? "😭" : (i===1 ? "😰" : (i===2 ? "😨" : "📉")); 
                        let dEqBadge = d.job_state ? (typeof d.job_state === 'string' ? JSON.parse(d.job_state).equipped_badge : d.job_state.equipped_badge) : null;
                        return `${md} ${i+1}位: ${formatPiconBadge(d.account_id, dEqBadge)}\n　💸 純資産: ${formatNumber(calculateNetWorth(d))} コイン`;
                    }).join('\n[hr]');
                    if (!s) s = "条件を満たすプレイヤーがいません。";
                } else if (cmdType === 'daily-rank') {
                    title = "🔥 本日の獲得額ランキング TOP10";
                    let activePlayers = f.filter(d => d.last_daily_date === today && d.daily_start_networth != null);
                    activePlayers.sort((a,b) => (calculateNetWorth(b) - b.daily_start_networth) - (calculateNetWorth(a) - a.daily_start_networth));
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        let profit = calculateNetWorth(d) - d.daily_start_networth;
                        return mapRankBadge(d, i, `📈 本日の利益: ${formatNumber(profit)} コイン`, "デイリー勝者");
                    }).join('\n[hr]');
                    if (!s) s = "条件を満たすプレイヤーがいません。";
                } else if (cmdType === 'drtp-rank') {
                    title = "💹 デイリーRTP(回収率)ランキング TOP10";
                    let activePlayers = f.filter(d => d.last_daily_date === today);
                    activePlayers.sort((a,b) => {
                        let aJs = typeof a.job_state === 'string' ? JSON.parse(a.job_state || '{}') : (a.job_state || {});
                        let bJs = typeof b.job_state === 'string' ? JSON.parse(b.job_state || '{}') : (b.job_state || {});
                        let aRTP = (aJs.daily_stats && aJs.daily_stats.bet > 0) ? (aJs.daily_stats.return / aJs.daily_stats.bet) : 0;
                        let bRTP = (bJs.daily_stats && bJs.daily_stats.bet > 0) ? (bJs.daily_stats.return / bJs.daily_stats.bet) : 0;
                        return bRTP - aRTP;
                    });
                    s = activePlayers.slice(0, 10).map((d, i) => {
                        let js = typeof d.job_state === 'string' ? JSON.parse(d.job_state || '{}') : (d.job_state || {});
                        let rtp = (js.daily_stats && js.daily_stats.bet > 0) ? ((js.daily_stats.return / js.daily_stats.bet) * 100).toFixed(1) : 0;
                        return mapRankBadge(d, i, `💹 デイリーRTP: ${rtp}%`, "デイリーRTP");
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
                player = { account_id: senderId, money: 0, bank: 0, debt: 0, last_interest_time: Date.now(), slot_count: 0, work_limit: 10, msg_count: 1, job: 'サラリーマン', daily_give_amount: 0, last_give_date: today, win_streak: 0, kabu_owned: 0, plays: 0, wins: 0, loses: 0, total_bet: 0, total_return: 0, russian_trauma_time: 0, last_daily_date: null, stocks: '{}', login_streak: 0, daily_start_networth: 0, items: '{}', job_state: '{}' };
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

            let eqBadge = player.job_state.equipped_badge || null;

            // デイリー処理
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
                // クエストのフラグ初期化
                player.job_state.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
                player.job_state.tenbin_active = false;
                player.job_state.sekigan_active = false;
                
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
                
                await sendTempMessage(roomId, `[info]🎁 デイリーボーナス！ (${streak}日連続ログイン)\n${formatPiconBadge(senderId, eqBadge)} 本日最初のアクションです。\n連続ログインボーナス ${formatNumber(dailyBonus)} コインを獲得！${jobMsg}[/info]`);
            }

            let myMoney = player ? player.money : 0;
            let myBank = player ? player.bank : 0;
            let myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';

            // トラウマチェック
            const isGameCmd = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|texas|yacht|sicbo|rolet|buta|daifugo|russian|crash|highlow|pachinko)\b/);
            const isJoinCmd = body.match(/(^|\n)[/#]join\b/);
            const isBetCmd = body.match(/(^|\n)[/#]bet\s+(max|half|[0-9.]+)/);
            if ((isGameCmd || isJoinCmd || isBetCmd) && gambleActive) {
                let remTrauma = checkTrauma(player);
                if (remTrauma > 0) {
                    return sendTempMessage(roomId, `[info]⚠️ ${formatPiconBadge(senderId, eqBadge)}\nロシアンルーレットの恐怖で手が震え、ゲームに参加できない…\n(残り ${remTrauma} 秒)[/info]`);
                }
            }

            // --- デイリークエスト機能 (仕事10回 -> 8回に緩和) ---
            if (/(^|\n)[/#]quest\b/.test(body)) {
                let js = player.job_state;
                if (!js.daily_quests) js.daily_quests = { work_count: 0, slot_count: 0, table_win_count: 0, pachinko_spin_count: 0, pachinko_reach_count: 0, silver_claimed: false, gold_claimed: false };
                let dq = js.daily_quests;
                
                let q1 = dq.work_count >= 3;
                let q2 = dq.work_count >= 8;
                let q3 = dq.slot_count >= 1;
                let q4 = dq.slot_count >= 3;
                let q5 = dq.table_win_count >= 1;
                let q6 = dq.table_win_count >= 5;
                let q7 = dq.pachinko_spin_count >= 10;
                let q8 = dq.pachinko_reach_count >= 1;

                let completedCount = [q1,q2,q3,q4,q5,q6,q7,q8].filter(x => x).length;
                let msg = `[info][title]📜 今日のデイリークエスト[/title]`;
                msg += `[ ${q1 ? '✅' : '　'} ] 仕事を3回する (${Math.min(dq.work_count,3)}/3)\n`;
                msg += `[ ${q2 ? '✅' : '　'} ] 仕事を8回する (${Math.min(dq.work_count,8)}/8)\n`;
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
                    getMoney += 10000; dq.silver_claimed = true;
                    getMsg += `\n🥈 銀のデイリーボーナス (10,000 コイン) を獲得しました！`;
                    addBadge(senderId, 'クエスト見習い', roomId);
                }
                if (completedCount >= 8 && !dq.gold_claimed) {
                    getMoney += 50000; dq.gold_claimed = true;
                    getMsg += `\n🥇 金のデイリーボーナス (50,000 コイン) を獲得しました！`;
                    addBadge(senderId, 'クエストマスター', roomId);
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

            // --- ステータス (旧型への巻き戻し ＋ 新機能付与) ---
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

                let js = targetPlayer.job_state || {};
                let tBadge = js.equipped_badge || null;
                
                let tMoney = targetPlayer.money || 0;
                let tBank = targetPlayer.bank || 0;
                let tJob = targetPlayer.job || 'サラリーマン';
                let tPlays = targetPlayer.plays || 0;
                let tWins = targetPlayer.wins || 0;
                let tTotalBet = targetPlayer.total_bet || 0;
                let tTotalReturn = targetPlayer.total_return || 0;
                let netWorth = calculateNetWorth(targetPlayer);
                
                let wr = tPlays ? ((tWins / tPlays) * 100).toFixed(1) : 0;
                let drtp = (js.daily_stats && js.daily_stats.bet > 0) ? ((js.daily_stats.return / js.daily_stats.bet) * 100).toFixed(1) : 0;

                const remSlot = Math.max(0, 5 - (targetPlayer.slot_count || 0));
                
                let kabuStr = '';
                if ((targetPlayer.kabu_owned || 0) > 0) kabuStr += `\n📦 カジノ株: ${targetPlayer.kabu_owned} 株`;
                if (targetPlayer.stocks) {
                    let s = JSON.parse(targetPlayer.stocks);
                    for (let k in s) if (s[k] > 0) kabuStr += `\n📦 ${k}: ${s[k]} 株`;
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

                let msg = `[info][title]📊 プレイヤー情報[/title]${formatPiconBadge(targetAid, tBadge)}
💰 所持金: ${formatNumber(tMoney)} コイン
🏦 銀行預金: ${formatNumber(tBank)} コイン
💎 純資産: ${formatNumber(netWorth)} コイン
👔 職業: ${tJob}
[hr]📉 本日の回収率(dRTP): ${drtp}%
⚔️ 戦績: ${tPlays}戦 ${tWins}勝 / 勝率: ${wr}%
💼 お仕事残り: ${targetPlayer.work_limit}回 / 🎰 スロット残り: ${remSlot}回${kabuStr}${itemStr}[/info]`;

                return sendTempMessage(roomId, msg, 120000);
            }

            // --- 転職・求人 (新ジョブ反映・運命廃止) ---
            const cJobMatch = body.match(/(^|\n)[/#]job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|ギャンブルオーナー|未来人|逆転のギャンブラー|銀行員|大富豪の執事|賞金稼ぎ|数学者|パチプロ|てんびん|隻眼)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {
                    'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, 
                    '賭博師': 200000, 'ギャンブルオーナー': 1000000, '未来人': 5000000,
                    '逆転のギャンブラー': 1000000, '銀行員': 1000000, '大富豪の執事': 400000,
                    '賞金稼ぎ': 10000, '数学者': 50000, 'パチプロ': 50000,
                    'てんびん': 500000, '隻眼': 400000
                };
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title]${formatPiconBadge(senderId, eqBadge)}\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (/(^|\n)[/#]job\b/.test(body) && !body.match(/(^|\n)[/#]job\s+/) && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)\n ▶ /#work (400〜2000)
🏛️ 公務員 (費用: 2000)\n ▶ /#work (1200〜2000)
🚓 警察官 (費用: 3000)\n ▶ /#work (1200〜2800)
⚽ プロスポーツ選手 (費用: 5000)\n ▶ /#work (2000〜4000)
🎰 賭博師 (費用: 200,000)\n ▶ 毎日初回ログイン時にスロット回数が5〜10回分増加
👑 ギャンブルオーナー (費用: 1,000,000)\n ▶ /#owner (1日1回、30分間他人のギャンブル負け金の50%を50%で回収)
👁️ 未来人 (費用: 5,000,000)\n ▶ /#next-future (1日1回、70%の確率でゲームの未来を予知)
🔄 逆転のギャンブラー (費用: 1,000,000)\n ▶ デイリーRTPが低いと、ギャンブルに負けた時80%の確率で返金
🏦 銀行員 (費用: 1,000,000)\n ▶ 毎日初回ログイン時に、銀行の預金に1%の複利利息
🎩 大富豪の執事 (費用: 400,000)\n ▶ ランキング1位か2位の人が稼ぐ度に利益の0.1%を得る
🎯 賞金稼ぎ (費用: 10,000)\n ▶ /#bounty [aid] ターゲットが次に負けた時、負け金の10%を奪う(1日1回)
🧮 数学者 (費用: 50,000)\n ▶ ルーレットの赤黒等の2倍配当が「2.1倍」になる
🎰 パチプロ (費用: 50,000)\n ▶ パチンコ遊技時の釘の入賞率が 5% から 7% に上がる
⚖️ てんびん (費用: 500,000)\n ▶ /#tenbin (1日1回、2択ゲームで勝率が10〜30%上昇。ただし10%で強制敗北)
👁️‍🗨️ 隻眼 (費用: 400,000)\n ▶ /#sekigan (1日1回、BJやヨットで一部の手札やダイスが見えなくなる代わりに配当が3倍)
[hr]※転職コマンド: /#job 役職名[/info]`);
            }

            // --- スキル処理 ---
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
                return sendTempMessage(roomId, `[info][title]👑 オーナー権限発動[/title]${formatPiconBadge(senderId, eqBadge)}\nここから30分間、他人がギャンブルで負けた金額の50%を50%の確率で回収します...！[/info]`);
            }

            if (/(^|\n)[/#]tenbin\b/.test(body) && gambleActive) {
                if (myJob !== 'てんびん') return sendTempMessage(roomId, `[info]⚠️ てんびん専用のコマンドです。[/info]`);
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ スキルは1日1回までです。[/info]`);
                player.job_state.tenbin_active = true;
                await supabase.from('players').update({ skill_date: today, job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info]⚖️ 【天秤】を発動しました！\n次に行う2択系ゲーム(参加者2人以上)の判定時、確率が自身に有利に変動します。(※稀に不運に傾きます)[/info]`);
            }

            if (/(^|\n)[/#]sekigan\b/.test(body) && gambleActive) {
                if (myJob !== '隻眼') return sendTempMessage(roomId, `[info]⚠️ 隻眼専用のコマンドです。[/info]`);
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ スキルは1日1回までです。[/info]`);
                player.job_state.sekigan_active = true;
                await supabase.from('players').update({ skill_date: today, job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info]👁️ 【隻眼】を発動しました！\n次のBJ・ヨットのベット時、自分の手札・ダイスの一部が見えなくなる代わりに配当が3倍になります。[/info]`);
            }

            if (/(^|\n)[/#]next-future\b/.test(body) && gambleActive) {
                if (myJob !== '未来人') return sendTempMessage(roomId, `[info]⚠️ 未来人専用のコマンドです。[/info]`);
                let g = gameState[roomId];
                if (!g || g.state === 'IDLE') return sendTempMessage(roomId, `[info]⚠️ 現在進行中のゲームはありません。[/info]`);
                if (g.state === 'RECRUITING') return sendTempMessage(roomId, `[info]⚠️ ゲームが開始されていません。[/info]`);
                if (g.type === 'derby') return sendTempMessage(roomId, `[info]⚠️ 競馬の未来は不確定要素が多すぎて視えません。[/info]`);
                
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 未来視の能力は1日1回までです。[/info]`);
                
                let isTrue = Math.random() < 0.7; // 70%の確率で正解
                let futureMsg = "";

                if (['bj', 'buta', 'texas', 'daifugo'].includes(g.type)) {
                    if (g.state === 'ACTION' && g.deck && g.deck.length > 0) {
                        let card = g.deck[g.deck.length - 1];
                        if (!isTrue) {
                            const suits = ['♠', '♥', '♣', '♦'], ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
                            let fc; do { fc = { suit: suits[Math.floor(Math.random()*4)], rank: ranks[Math.floor(Math.random()*13)] }; } while (fc.suit === card.suit && fc.rank === card.rank);
                            card = fc;
                        }
                        futureMsg = `次に出るカードは【 ${card.suit}${card.rank} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ 今は未来を視るタイミングではありません。[/info]`);
                } else if (g.type === 'rolet') {
                    if (g.state === 'BETTING') {
                        if (g.futureResult === undefined) g.futureResult = Math.floor(Math.random() * 37);
                        let realColor = getRouletteColorStr(g.futureResult).replace(/[^🔴⚫🟢赤黒緑]/g, ''); 
                        if (!isTrue) {
                            let colors = ["🔴赤", "⚫黒", "🟢緑"].filter(c => c !== realColor);
                            realColor = colors[Math.floor(Math.random()*colors.length)];
                        }
                        futureMsg = `次のルーレットの色は【 ${realColor} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'sicbo') {
                    if (g.state === 'BETTING') {
                        if (!g.futureResult) g.futureResult = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                        let dice = g.futureResult;
                        if (!isTrue) {
                            let falseDice; do { falseDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1]; } while(falseDice.join(',') === dice.join(','));
                            dice = falseDice;
                        }
                        futureMsg = `次のダイスは【 ${dice.join(', ')} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'chouhan') {
                    if (g.state === 'BETTING') {
                        if (!g.futureResult) g.futureResult = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                        let dice = g.futureResult;
                        if (!isTrue) {
                            let falseDice; do { falseDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1]; } while(falseDice.join(',') === dice.join(','));
                            dice = falseDice;
                        }
                        futureMsg = `次の壺の中身は【 ${dice[0]} と ${dice[1]} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'cc') {
                    if (g.state === 'BETTING') {
                        if (!g.botRoll) g.botRoll = generateChinchiroRoll();
                        let d = g.botRoll.dice;
                        if (!isTrue) {
                            let falseDice; do { falseDice = generateChinchiroRoll().dice; } while(falseDice.join(',') === d.join(','));
                            d = falseDice;
                        }
                        futureMsg = `親(ディーラー)の出目は【 ${d.join(', ')} 】のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ ベット中に使用してください。[/info]`);
                } else if (g.type === 'crash') {
                    if (g.state === 'BETTING') {
                        if (!g.crashPoint) {
                            let cp = Math.max(1.00, (0.95 / Math.random())); if (cp > 100) cp = 100.0;
                            g.crashPoint = cp.toFixed(2);
                        }
                        let cp = g.crashPoint;
                        if (!isTrue) {
                            let falseCp; do { falseCp = Math.max(1.00, (0.95 / Math.random())).toFixed(2); } while(falseCp === cp);
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
                                let falseDice; do { falseDice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); } while(falseDice.join(',') === d.join(','));
                                d = falseDice;
                            }
                            futureMsg = `あなたが次に振るダイスは【 ${d.join(', ')} 】のようです...`;
                        } else return sendTempMessage(roomId, `[info]⚠️ 自分のターンで使用してください。[/info]`);
                    } else return sendTempMessage(roomId, `[info]⚠️ アクション中に使用してください。[/info]`);
                } else if (g.type === 'russian') {
                    if (g.state === 'ACTION') {
                        let dist = (g.bulletPos - g.currentChamber + 6) % 6;
                        if (!isTrue) {
                            let falseDist; do { falseDist = Math.floor(Math.random() * 6); } while (falseDist === dist);
                            dist = falseDist;
                        }
                        if (dist === 0) futureMsg = `次引き金を引くと【 弾が出る 】ようです...`;
                        else futureMsg = `あと【 ${dist} 回 】は空砲のようです...`;
                    } else return sendTempMessage(roomId, `[info]⚠️ アクション中に使用してください。[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ このゲームでは未来視できません。[/info]`);

                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]👁️ 未来視[/title]${formatPiconBadge(senderId, eqBadge)}\n頭の中に未来のビジョンが流れ込んできた...！\n\n${futureMsg}[/info]`);
            }

            if (/(^|\n)[/#]bounty\b/.test(body)) {
                if (myJob !== '賞金稼ぎ') return sendTempMessage(roomId, `[info]⚠️ 賞金稼ぎ専用コマンドです。[/info]`);
                let target = repliedAid || (body.match(/(^|\n)[/#]bounty\s+([0-9]+)/)||[])[2];
                if (!target) return sendTempMessage(roomId, `[info]⚠️ ターゲットを指定してください。[/info]`);
                if (globalRankExcluded.includes(target)) return sendTempMessage(roomId, `[info]⚠️ その者は格が違います。(無効なターゲット)[/info]`);
                player.job_state.bounty_target = target;
                await supabase.from('players').update({ job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info]🎯 ターゲットを [piconname:${target}] に設定しました。次に敗北した際、没収額の10%を奪います。[/info]`);
            }

            if (/(^|\n)[/#]joker\b/.test(body)) {
                let target = repliedAid || (body.match(/(^|\n)[/#]joker\s+([0-9]+)/)||[])[2];
                if (!target) return sendTempMessage(roomId, `[info]⚠️ ターゲットを指定してください。[/info]`);
                if (globalRankExcluded.includes(target)) return sendTempMessage(roomId, `[info]⚠️ その者には近づかない方が無難だ。(無効なターゲット)[/info]`);
                if (await checkHasItem(senderId, 'ジョーカーの招待状')) {
                    let useRes = await tryUseItem(senderId, 'ジョーカーの招待状');
                    if (useRes.success) {
                        player.job_state.joker_target = target;
                        await supabase.from('players').update({ job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);
                        return sendTempMessage(roomId, `[info]🃏 【ジョーカーの招待状】を使用しました！\nターゲット: [piconname:${target}]\n相手が次に勝利した際、配当を横取りします。[/info]`);
                    } else {
                        return sendTempMessage(roomId, `[info]${useRes.msg}[/info]`);
                    }
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ ジョーカーの招待状を持っていません！[/info]`);
                }
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
                else if(myJob === 'パチプロ'){ e=Math.floor(Math.random()*1501)+500; m=`優良台のデータを取り、 ${formatNumber(e)} コイン稼ぎました！🎰`; }
                else if(myJob === 'てんびん'){ e=Math.floor(Math.random()*1501)+1000; m=`天秤で価値を測り、 ${formatNumber(e)} コイン稼ぎました！⚖️`; }
                else if(myJob === '隻眼'){ e=Math.floor(Math.random()*2001)+1200; m=`鋭い観察眼で調査し、 ${formatNumber(e)} コイン稼ぎました！👁️`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoney(senderId, e); 
                await updateQuest(senderId, 'work_count', 1);
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title]${formatPiconBadge(senderId, eqBadge)}\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            const sM = body.match(/(^|\n)[/#]slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (player.slot_count >= 5) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 60000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(1分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? Math.min(myMoney, 9990000) : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                if (bet > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                if (bet < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);
                
                if (bet > 0 && myMoney >= bet) {
                    let updates = { money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() };
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
                        ml = buffRes.mult;
                        res = buffRes.resTxt;
                    }

                    let wA = bet * ml; 
                    if (wA > 0) {
                        let { stolen, jokerMsg } = await processJoker(senderId, wA, roomId);
                        wA -= stolen;
                        res += jokerMsg;
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

            // パチンコのスキップ処理 (/skip)
            if (/(^|\n)[/#]skip\b/.test(body) && gambleActive) {
                if (pachinkoPlayers[senderId]?.active) {
                    pachinkoPlayers[senderId].skip = true;
                    return sendTempMessage(roomId, `[info]⏩ ${formatPiconBadge(senderId, eqBadge)} \n演出をスキップしました。裏側で高速消化中です...[/info]`);
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ 現在パチンコを遊技していません。[/info]`);
                }
            }

            if (/(^|\n)[/#]pachinko\s+([0-9]+)/.test(body) && gambleActive) {
                let amt = parseInt(body.match(/(^|\n)[/#]pachinko\s+([0-9]+)/)[2], 10);
                if (amt < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);
                if (myMoney < amt) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！[/info]`);
                if (pachinkoPlayers[senderId]?.active) return sendTempMessage(roomId, `[info]⚠️ 既にパチンコを遊技中です。1人1台までです。(演出スキップは /#skip を使用)[/info]`);
                
                let balls = Math.floor(amt / 4);
                if (balls <= 0) return sendTempMessage(roomId, `[info]⚠️ 玉を借りられません。[/info]`);
                
                let startEntryRate = myJob === 'パチプロ' ? 0.07 : 0.05;
                if (player.job_state.lucky_kugi_active) {
                    startEntryRate = 1.0;
                    player.job_state.lucky_kugi_active = false;
                }
                
                myMoney -= amt;
                await supabase.from('players').update({ money: myMoney, job_state: JSON.stringify(player.job_state) }).eq('account_id', senderId);

                pachinkoPlayers[senderId] = { active: true, skip: false, balls: balls };

                let msgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info][title]🎰 パチンコ台 稼働開始[/title]遊技者: ${formatPiconBadge(senderId, eqBadge)}\n投入: ${formatNumber(amt)} コイン (${balls}玉)\n釘状態(入賞率): ${Math.floor(startEntryRate*100)}%\n\n玉打ち出しスタート... (※演出省略: /#skip)[/info]`)}`);
                let mId = msgRes?.data?.message_id;

                (async () => {
                    let totalSpins = 0;
                    let totalRashPayout = 0;
                    let totalRashCount = 0;
                    let currentMaxRushStreak = player.job_state.pachinko_max_streak || 0;
                    
                    try {
                        let bRemaining = pachinkoPlayers[senderId].balls;
                        
                        while(bRemaining > 0) {
                            let consume = Math.min(15, bRemaining);
                            bRemaining -= consume;

                            let hitsThisBatch = false, spinsInBatch = 0;
                            for (let i = 0; i < consume; i++) {
                                if (Math.random() < startEntryRate) {
                                    spinsInBatch++; totalSpins++;
                                    if (Math.random() < (1/319)) {
                                        hitsThisBatch = true;
                                        bRemaining += (consume - i - 1); 
                                        break;
                                    }
                                }
                            }
                            await updateQuest(senderId, 'pachinko_spin_count', spinsInBatch);

                            if (hitsThisBatch) {
                                await updateQuest(senderId, 'pachinko_reach_count', 1);
                                
                                let streak = 1; let pot = 4000;
                                while(Math.random() < 0.70) {
                                    streak++; pot += (Math.floor(Math.random()*2000)+3000);
                                }
                                totalRashCount++; totalRashPayout += pot;

                                if (streak > currentMaxRushStreak) {
                                    currentMaxRushStreak = streak;
                                    let latest = await supabase.from('players').select('job_state').eq('account_id', senderId).single();
                                    if(latest?.data?.job_state){
                                        let jsb = typeof latest.data.job_state==='string'?JSON.parse(latest.data.job_state):latest.data.job_state;
                                        jsb.pachinko_max_streak = currentMaxRushStreak;
                                        await supabase.from('players').update({job_state: JSON.stringify(jsb)}).eq('account_id', senderId);
                                    }
                                }

                                if (!pachinkoPlayers[senderId].skip && mId) {
                                    await editMessage(roomId, mId, `[info][title]🎰 激アツ！ パチンコ[/title]遊技者: ${formatPiconBadge(senderId, eqBadge)}\n[現在 ${totalSpins} 回転目...] (残り${bRemaining}玉)\n\n💥 キュインキュイーーーーン！大当たり！！ 💥\n⚡ RUSH突入!! ⚡\n↓\n🔥🔥 [ 継続: ${streak} 連チャン / 今回の獲得: ${formatNumber(pot)} ] 🔥🔥\n(まだ玉が残っているので稼働継続します...)[/info]`);
                                    await sleep(2500);
                                }
                            } else {
                                if (!pachinkoPlayers[senderId].skip && mId) {
                                    if (Math.random() < 0.3) {
                                        await sleep(350);
                                    }
                                }
                                await sleep(350); 
                            }
                        }

                        delete pachinkoPlayers[senderId];

                        if (totalRashPayout > 0) {
                            let { stolen, jokerMsg } = await processJoker(senderId, totalRashPayout, roomId);
                            let fWin = totalRashPayout - stolen;

                            await addMoney(senderId, fWin);
                            await updatePlayerStats(senderId, amt, totalRashPayout, 'win', true);
                            await processButler(senderId, totalRashPayout, roomId);

                            let rMsg = `[info][title]🎰 パチンコ 遊技終了 (全玉消化)[/title]${formatPiconBadge(senderId, eqBadge)}\n投入金: ${formatNumber(amt)} コイン\n\n🎯 最終結果: 総計 ${totalSpins} 回転！ (当たり総計: ${totalRashCount} 回)\n🌈 全RUSHトータル獲得額: ${formatNumber(fWin)} コイン獲得！！！${jokerMsg}[/info]`;
                            if(mId) await editMessage(roomId, mId, rMsg); else sendMessage(roomId, rMsg);
                        } else {
                            await updatePlayerStats(senderId, amt, 0, 'lose', true);
                            let bountyMsg = await processBounty(senderId, amt, roomId);
                            let lMsg = `[info][title]🎰 パチンコ 遊技終了 (全玉消化)[/title]${formatPiconBadge(senderId, eqBadge)}\n投入金: ${formatNumber(amt)} コイン\n\n💀 ${totalSpins} 回 デジタルが回ったが、全てハズレ。出玉ゼロ(0)。\n${bountyMsg}[/info]`;
                            if(mId) await editMessage(roomId, mId, lMsg); else sendMessage(roomId, lMsg);
                        }
                    } catch(err) {
                        delete pachinkoPlayers[senderId]; 
                    }
                })();
                return;
            }

            // --- ゲーム募集コマンドの検知 ---
            const gameCmdMatch = body.match(/(^|\n)[/#](chouhan|cc|derby|bj|texas|yacht|sicbo|rolet|buta|daifugo|russian|highlow)\b/);
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
                         t==='texas' ? "🃏 テキサスホールデム" : 
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
                    gameState[roomId].stats = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加希望者は ${ex} と入力してください！ (現在 1人)\n[hr]※1分経過またはホストが /#start と入力すると開始します。${ruleAdd}[/info]`); 
                
                startGameTimer(roomId); 
                return;
            }

            // --- ゲームへの参加・ベット・アクション ---
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
                    
                    let pMsg = "";
                    if (gameState[roomId].state === 'ACTION' || gameState[roomId].state === 'BETTING') {
                        if (p.bet > 0) {
                            await supabase.from('players').update({ win_streak: 0 }).eq('account_id', senderId);
                            pMsg = " (賭け金没収: 敗北扱い)";
                            await updatePlayerStats(p.aid, p.bet, 0, 'lose');
                            kabuData.pendingProfit = (kabuData.pendingProfit || 0) + p.bet;
                        }
                    } else {
                        pMsg = " (退出)";
                    }

                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] がゲームから退出しました。${pMsg}[/info]`);
                    
                    if (gameState[roomId].players.length === 0 || (gameState[roomId].type === 'russian' && gameState[roomId].players.length < 2)) { 
                        clearTimeout(gameState[roomId].timeoutId); 
                        if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者が規定人数未満になったため、ゲームを中止します。[/info]`); 
                    }
                    if (gameState[roomId].state !== 'RECRUITING') {
                        checkGameProgress(roomId);
                    }
                } else if (spIdx !== -1) {
                    let s = gameState[roomId].spectators[spIdx];
                    gameState[roomId].spectators.splice(spIdx, 1);
                    let pMsg = "";
                    if (s.bet > 0) {
                        pMsg = " (賭け金没収)";
                        await processOwnerSkill(s.aid, s.bet, roomId);
                        await updatePlayerStats(s.aid, s.bet, 0, 'lose');
                        kabuData.pendingProfit = (kabuData.pendingProfit || 0) + s.bet;
                    } else {
                        pMsg = " (退出)";
                    }
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が観戦から退出しました。${pMsg}[/info]`);
                    checkGameProgress(roomId);
                }
                return;
            }

            const bM = body.match(/(^|\n)[/#]bet\s+(max|half|[0-9]+)(?:\s+([a-zA-Z0-9-.]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let g = gameState[roomId];
                
                let pl = g.players.find(x => x.aid === senderId);
                let sp = g.spectators ? g.spectators.find(x => x.aid === senderId) : null;

                if (pl && pl.bet === 0) {
                    let betType = bM[2];

                    let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                    if (b > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                    if (b < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);

                    if (b > 0 && myMoney >= b) {
                        if (g.type === 'russian') {
                            if (!g.minBet) {
                                let opponent = g.players.find(p => p.aid !== senderId);
                                let { data: oppData } = await supabase.from('players').select('money, bank').eq('account_id', opponent.aid).single();
                                let oppTotal = (oppData?.money || 0) + (oppData?.bank || 0);
                                let maxAllowed = Math.floor(oppTotal / 2);
                                
                                if (b >= maxAllowed) return sendTempMessage(roomId, `[info]⚠️ 相手の全財産の半分(${formatNumber(maxAllowed)})未満の金額を設定してください。[/info]`);
                                
                                g.minBet = b; pl.bet = b;
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
                        
                        // --- 隻眼スキルの自動発動判定 ---
                        if (player.job_state && player.job_state.sekigan_active && ['bj','yacht'].includes(g.type)) {
                            pl.isOneEyeActive = true;
                            player.job_state.sekigan_active = false;
                            updates.job_state = JSON.stringify(player.job_state);
                        }

                        await supabase.from('players').update(updates).eq('account_id', senderId);
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${formatNumber(b)} コインをベットしました！[/info]`);
                        checkGameProgress(roomId);
                    } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
                    
                } else if (sp && sp.bet === 0) {
                    let betType = bM[2];
                    let targetAid = repliedAid || bM[3];
                    if (!targetAid || !g.players.find(p => p.aid === targetAid)) {
                        return sendTempMessage(roomId, `[info]⚠️ 応援するプレイヤーのaidを指定するか、その人に返信してベットしてください。\n例: /#bet 100 123456[/info]`);
                    }

                    let b = betType === 'max' ? Math.min(myMoney, 9990000) : (betType === 'half' ? Math.floor(myMoney/2) : parseInt(betType, 10));
                    if (b > 9990000) return sendTempMessage(roomId, `[info]⚠️ 1回の最大ベット額は 9,990,000 コインまでです。[/info]`);
                    if (b < 500) return sendTempMessage(roomId, `[info]⚠️ 最低賭け金は 500 コインです。[/info]`);

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
                        
                        let { data: lData } = await supabase.from('players').select('job_state').eq('account_id', loser.aid).single();
                        let lJs = lData && typeof lData.job_state === 'string' ? JSON.parse(lData.job_state || '{}') : (lData?.job_state || {});

                        if (lJs.death_reverse_active) {
                            lJs.death_reverse_active = false;
                            await supabase.from('players').update({ job_state: JSON.stringify(lJs) }).eq('account_id', loser.aid);
                            isReversed = true;
                            await sendMessage(roomId, `[info]🔄 【デス・リバース】発動！！！\n死の運命が反転し、[piconname:${loser.aid}] は [piconname:${winner.aid}] を道連れにした！！[/info]`);
                            await sleep(2000);
                        }

                        let totalPot = g.players[0].bet + g.players[1].bet;

                        if (isReversed) {
                            await addMoney(winner.aid, winner.bet);
                            await addMoney(loser.aid, loser.bet);
                            await updatePlayerStats(winner.aid, winner.bet, winner.bet, 'draw', true);
                            await updatePlayerStats(loser.aid, loser.bet, loser.bet, 'draw', true);
                            await sendMessage(roomId, `[info][title]💀 相打ち[/title]両者引き分けとなり、賭け金は返還されました。[/info]`);
                        } else {
                            await addMoney(winner.aid, totalPot);
                            await updatePlayerStats(winner.aid, winner.bet, totalPot, 'win', true);
                            await updatePlayerStats(loser.aid, loser.bet, 0, 'lose', true);
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
                                
                                let animStr = "";
                                if (pl.isOneEyeActive) {
                                    animStr = `[ 🎲${tempD[0]} ]  [ 🎲${tempD[1]} ]  [ 🎲？ ]  [ 🎲？ ]  [ 🎲？ ]`;
                                } else {
                                    animStr = `[ ${tempD.map(d=>`🎲${d}`).join(' ')} ]`;
                                }

                                await editMessage(roomId, mId, `[info]🎲 [piconname:${pl.aid}] サイコロを振っています...\n${animStr}[/info]`);
                            }
                            if (pl.futureDice) { pl.dice = pl.futureDice; delete pl.futureDice; }
                            else { pl.dice = Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); }
                            pl.rolls = 1;
                            
                            let finalAnimStr = pl.isOneEyeActive ? `[ 🎲${pl.dice[0]} ]  [ 🎲${pl.dice[1]} ]  [ 🎲？ ]  [ 🎲？ ]  [ 🎲？ ]` : `[ ${pl.dice.map(d=>`🎲${d}`).join(' ')} ]`;
                            await editMessage(roomId, mId, `[info]🎲 [piconname:${pl.aid}] サイコロを振りました。\n${finalAnimStr}[/info]`);
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

            if (body.match(/(^|\n)[/#]change\b/) && gambleActive && gameState[roomId]?.type === 'yacht' && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    let match = body.match(/^[/#]change\s+([0-9\s]+)$/);
                    if (match) {
                        let nums = match[1].trim().split(/\s+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 5);
                        let cMsgRes = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(`[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...[/info]`)}`);
                        if (cMsgRes && cMsgRes.data) {
                            let cmId = cMsgRes.data.message_id;
                            for(let i=0; i<8; i++) {
                                await sleep(300);
                                let tempD = [...pl.dice];
                                let animStr = tempD.map((d, idx) => {
                                    if (nums.includes(idx + 1)) return `[ 🎲${Math.floor(Math.random() * 6) + 1} ]`;
                                    if (pl.isOneEyeActive && idx >= 2) return ` 🎲？ `;
                                    return ` 🎲${d} `; 
                                }).join('  ');
                                await editMessage(roomId, cmId, `[info]🎲 [piconname:${pl.aid}] サイコロを振り直しています...\n${animStr}[/info]`);
                            }

                            nums.forEach(idx => pl.dice[idx-1] = Math.floor(Math.random() * 6) + 1);
                            pl.rolls++;
                            
                            let ev = pl.isOneEyeActive ? {name:"？(見えない)"} : getYachtRank(pl.dice);
                            if (pl.rolls >= 3) {
                                pl.status = 'stand';
                                let finalDiceStr = pl.isOneEyeActive 
                                    ? `🎲${pl.dice[0]} 🎲${pl.dice[1]} 🎲？ 🎲？ 🎲？`
                                    : pl.dice.map(d => `🎲${d}`).join(' ');
                                await editMessage(roomId, cmId, `[info][piconname:${pl.aid}] 3回目の振り直し完了！\n確定サイコロ: ${finalDiceStr} (${ev.name})[/info]`);
                                g.turnIndex++;
                                await proceedNextYachtTurn(roomId);
                            } else {
                                let currentDiceStr = pl.dice.map((d, i) => {
                                    if (pl.isOneEyeActive && i >= 2) return `[${i + 1}] 🎲？`;
                                    return `[${i + 1}] 🎲${d}`;
                                }).join('   ');
                                await editMessage(roomId, cmId, `[info][title]🎲 ヨット ターン継続 ( ${pl.rolls}/3 回目 )[/title][piconname:${pl.aid}]\nサイコロ: ${currentDiceStr}\n役: ${ev.name}\n\n/#change [番号] または /#stand[/info]`);
                                startGameTimer(roomId, 60000);
                            }
                        }
                    } else {
                        await sendTempMessage(roomId, `[info]⚠️ 番号(1〜5)を指定してください。例: /#change 1 3 5[/info]`);
                    }
                }
                return;
            }
            
            const isHitOrStand = /(^|\n)[/#]hit\b/.test(body) || /(^|\n)[/#]stand\b/.test(body) || /(^|\n)[/#]fold\b/.test(body);
            if (isHitOrStand && gambleActive && (gameState[roomId]?.type === 'bj' || gameState[roomId]?.type === 'texas' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (/(^|\n)[/#]hit\b/.test(body)) {
                        if (g.type !== 'bj') return;
                        
                        let c = g.deck.pop();
                        pl.hand.push(c);
                        
                        let score = calculateBJScore(pl.hand);
                        
                        let hStr = "";
                        if (pl.isOneEyeActive) {
                            hStr = `${pl.hand[0].suit}${pl.hand[0].rank} / [？] / ` + pl.hand.slice(2).map(cd => cd.suit + cd.rank).join(' ');
                            score = "??";
                        } else {
                            hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        }

                        if (score !== "??" && score > 21) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else if (score !== "??" && score === 21) {
                            pl.status = 'stand';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n\n/#hit または /#stand[/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (/(^|\n)[/#]fold\b/.test(body)) {
                        if (g.type !== 'texas') return;
                        pl.status = 'fold';
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 🏳️ フォールド(降り)しました。\n(賭け金は没収されます)[/info]`);
                        g.turnIndex++;
                        await proceedNextTexasTurn(roomId);
                    } else if (/(^|\n)[/#]stand\b/.test(body)) {
                        pl.status = 'stand';
                        let desc = '';
                        if (g.type === 'texas') {
                            desc = `確定手札: ${pl.hand.map(c => c.suit + c.rank).join(' ')}`;
                        } else if (g.type === 'yacht') {
                            if (pl.isOneEyeActive) {
                                desc = `確定サイコロ: 🎲${pl.dice[0]} 🎲${pl.dice[1]} 🎲？ 🎲？ 🎲？ (見えない)`;
                            } else {
                                desc = `確定サイコロ: ${pl.dice.map(d => `🎲${d}`).join(' ')} (${getYachtRank(pl.dice).name})`;
                            }
                        } else {
                            desc = pl.isOneEyeActive ? "スコア: ??" : `スコア: ${calculateBJScore(pl.hand)}`;
                        }
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 勝負(スタンド)しました。\n${desc}[/info]`);
                        
                        g.turnIndex++; 
                        if (g.type === 'texas') await proceedNextTexasTurn(roomId);
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

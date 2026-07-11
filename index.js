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
const gameState = {}; // 全ゲームの進行状況管理

supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

// --- Date & Formatting Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNumber = (n) => Number(n).toLocaleString();

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- Chatwork Messages ---
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

// --- お金・借金管理 (自動返済機能) ---
const addMoneyWithRepay = async (accountId, amount) => {
    const { data: player } = await supabase.from('players').select('*').eq('account_id', accountId).single();
    let money = player ? player.money : 0;
    let debt = player ? (player.debt || 0) : 0;

    if (debt > 0 && amount > 0) {
        let repayAmount = Math.min(debt, amount);
        debt -= repayAmount;
        amount -= repayAmount;
    }
    money += amount;

    if (player) {
        await supabase.from('players').update({ money: money, debt: debt }).eq('account_id', accountId);
    } else {
        await supabase.from('players').insert({ account_id: accountId, money: money, debt: debt, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 0, job: 'サラリーマン' });
    }
};

// --- 特殊能力サポート処理 ---
const applyMasterTax = async (lostAmount) => {
    try {
        const { data: masterData } = await supabase.from('config').select('value').eq('key', 'master_buff').single();
        if (masterData && masterData.value) {
            let buff = JSON.parse(masterData.value);
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

const consumeMiraiBuff = async (accountId) => {
    try {
        const { data: miraiData } = await supabase.from('config').select('value').eq('key', 'mirai_buff').single();
        if (miraiData && miraiData.value === accountId.toString()) {
            await supabase.from('config').upsert({ key: 'mirai_buff', value: '' });
            return Math.random() < 0.8; // 80%の確率で効果発動
        }
        return false;
    } catch(e) { return false; }
};

const recordMoneyHistory = async () => {
    try {
        const { data: playersList } = await supabase.from('players').select('account_id, money');
        const { data: historyData } = await supabase.from('config').select('value').eq('key', 'money_history').single();
        let history = historyData && historyData.value ? JSON.parse(historyData.value) : [];
        const now = Date.now();
        history = history.filter(h => now - h.time <= 300000); // 5分以内のデータのみ保持
        history.push({ time: now, states: playersList });
        await supabase.from('config').upsert({ key: 'money_history', value: JSON.stringify(history) });
    } catch(e) {}
};

// --- 管理・防衛機能 ---
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

// --- ゲームエンジン ---
const generateDerby = () => {
    let stats = []; 
    for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0;
    let oddsMap = {}, oddsStr = "";
    
    for(let i=1; i<=5; i++){
        for(let j=i+1; j<=6; j++){
            let weight = stats[i-1] * stats[j-1];
            combos.push({ combo: `${i}-${j}`, weight: weight });
            totalWeight += weight;
        }
    }
    
    combos.forEach(c => {
        let odd = (0.8 / (c.weight / totalWeight)).toFixed(1);
        if (odd < 1.1) odd = 1.1; if (odd > 150) odd = 150.0;
        oddsMap[c.combo] = Number(odd);
    });
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => {
        oddsStr += `🐎 ${k} : [code]${oddsMap[k]}倍[/code]\n`;
    });
    return { oddsMap, oddsStr, stats };
};

const getChinchiroRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0] === 1 && d[1] === 1 && d[2] === 1) return { dice: d, name: "ピンゾロ", rank: 6, score: 1, mult: 5 };
        if (d[0] === d[1] && d[1] === d[2]) return { dice: d, name: `${d[0]}の嵐`, rank: 5, score: d[0], mult: 3 };
        if (d[0] === 4 && d[1] === 5 && d[2] === 6) return { dice: d, name: "シゴロ", rank: 4, score: 6, mult: 2 };
        if (d[0] === 1 && d[1] === 2 && d[2] === 3) return { dice: d, name: "ヒフミ", rank: 0, score: 0, mult: -2 };
        if (d[0] === d[1]) return { dice: d, name: `${d[2]}の目`, rank: 2, score: d[2], mult: 1 };
        if (d[1] === d[2]) return { dice: d, name: `${d[0]}の目`, rank: 2, score: d[0], mult: 1 };
        if (d[0] === d[2]) return { dice: d, name: `${d[1]}の目`, r: 2, score: d[1], mult: 1 };
    }
    return { dice: [0,0,0], name: "目なし", rank: 1, score: 0, mult: 1 };
};

// --- ゲーム進行・タイマー ---
const startGameTimer = (roomId, ms = 60000, isDerby = false) => {
    let game = gameState[roomId]; 
    if (!game) return;
    
    if (game.timeoutId) clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    
    if (isDerby) {
        game.remindId = setTimeout(() => {
            if (gameState[roomId] && gameState[roomId].state === 'BETTING') {
                sendTempMessage(roomId, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\n[code]/bet [額] [馬1-馬2][/code] を入力してください。[/info]`);
            }
        }, ms - 60000);
    }
    game.timeoutId = setTimeout(() => handleGameTimeout(roomId), ms);
};

const handleGameTimeout = async (roomId) => {
    let game = gameState[roomId]; if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        if (game.players.length >= 2) {
            game.state = 'BETTING';
            if (game.type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else {
        let kickedAids = [], activePlayers = [];
        for (let player of game.players) {
            let isKicked = false;
            if (game.state === 'BETTING' && player.bet === 0) isKicked = true;
            if (game.state === 'ACTION' && (game.type === 'chouhan' && !player.choice || game.type === 'cc' && !player.rollResult && player.aid !== game.host)) isKicked = true;
            
            if (isKicked) { 
                kickedAids.push(player.aid); 
                if (player.bet > 0) await addMoneyWithRepay(player.aid, player.bet); 
            } else { activePlayers.push(player); }
        }
        game.players = activePlayers;
        
        if (kickedAids.length > 0) await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        
        if (game.players.length < 2) {
            for (let player of game.players) { if (player.bet > 0) await addMoneyWithRepay(player.aid, player.bet); }
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gameState[roomId] = null;
        } else await checkGameProgress(roomId);
    }
};

const checkGameProgress = async (roomId) => {
    let game = gameState[roomId]; if (!game || game.state === 'IDLE') return;
    
    if (game.state === 'BETTING' && game.players.length >= 2 && game.players.every(p => p.bet > 0)) {
        if (game.type === 'derby') {
            clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
            await resolveDerby(roomId);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "親以外は [code]/roll[/code] でサイコロを振ってください。";
            await sendTempMessage(roomId, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(roomId, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.length >= 2 && game.players.every(p => p.choice)) await resolveChouhan(roomId);
        if (game.type === 'cc' && game.players.length >= 2 && game.players.filter(x => x.aid !== game.host).every(p => p.rollResult)) await resolveChinchiro(roomId);
    }
};

// --- ゲーム結果精算 ---
const resolveChinchiro = async (roomId) => {
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId);
    let parentRoll = getChinchiroRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${game.host}]) の出目 】\n[ ${parentRoll.dice.join(', ')} ] ➡ 『 ${parentRoll.name} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        if (player.aid === game.host) continue;
        let r = player.rollResult || { rank: 1, name: "欠席", mult: 1, score: 0, dice: [0,0,0] };
        
        let isMirai = await consumeMiraiBuff(player.aid);
        let win = isMirai || (r.rank > parentRoll.rank) || (r.rank === parentRoll.rank && r.score > parentRoll.score);
        let draw = !isMirai && (r.rank === parentRoll.rank && r.score === parentRoll.score);
        
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if (draw) { 
            await addMoneyWithRepay(player.aid, player.bet); 
            msg += `😐 [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 引き分け (返金)\n`; 
        } else if (win) { 
            let mult = r.mult > 0 ? r.mult : 1; 
            await addMoneyWithRepay(player.aid, player.bet + (player.bet * mult)); 
            msg += `(cracker) [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 勝ち！ (+${formatNumber(player.bet * mult)})\n`; 
        } else { 
            await applyMasterTax(player.bet);
            msg += `💀 [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 負け...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveChouhan = async (roomId) => {
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId);
    let d1 = Math.floor(Math.random() * 6) + 1;
    let d2 = Math.floor(Math.random() * 6) + 1;
    let sum = d1 + d2;
    let result = (sum % 2 === 0) ? 'chou' : 'han';
    
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        let isMirai = await consumeMiraiBuff(player.aid);
        let isWin = isMirai || (player.choice === result);
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if (isWin) { 
            await addMoneyWithRepay(player.aid, player.bet * 2); 
            msg += `(cracker) [piconname:${player.aid}]: 的中！ (+${formatNumber(player.bet * 2)} コイン)\n`; 
        } else { 
            await applyMasterTax(player.bet);
            msg += `💀 [piconname:${player.aid}]: 予想[${player.choice === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveDerby = async (roomId) => {
    let game = gameState[roomId]; if (!game) return; clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
    let stats = game.stats, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
    
    let r1 = Math.random() * totalW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    
    ws[first-1] = 0; 
    totalW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * totalW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`;
    let odd = game.oddsMap[winCombo];
    
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    
    for(let player of game.players){
        let isMirai = await consumeMiraiBuff(player.aid);
        let isWin = isMirai || (player.choice === winCombo);
        if (isMirai) msg += `🌟 未来改変発動！\n`;

        if(isWin){ 
            let winAmt = Math.floor(player.bet * (isMirai && player.choice !== winCombo ? (game.oddsMap[player.choice] || 2) : odd)); 
            await addMoneyWithRepay(player.aid, player.bet + winAmt); 
            msg += `(cracker) [piconname:${player.aid}]: 的中！ (+${formatNumber(winAmt)} コイン)\n`; 
        } else { 
            await applyMasterTax(player.bet);
            msg += `💀 [piconname:${player.aid}]: 予想[${player.choice}] ➡ はずれ...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};
// ====== 前半はここまで ======
// ====== 後半はここから ======
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id;
    const body = ev.body || "";
    const senderId = ev.account_id.toString();
    const msgId = ev.message_id;
    
    const today = getTodayStr();
    const thisMonth = getThisMonthStr();

    (async () => {
        try {
            // --- 返信タグの解析 ---
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. プレイヤーデータの確実な取得と作成
            let { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            
            if (!pData) {
                pData = { account_id: senderId, money: 0, debt: 0, slot_count: 0, work_limit: 5, extra_slots: 0, msg_count: 1, job: 'サラリーマン' };
                await supabase.from('players').insert(pData);
            } 
            else if (gambleActive && !body.startsWith('/')) {
                let mc = (pData.msg_count || 0) + 1; 
                let wl = pData.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                pData.msg_count = mc; pData.work_limit = wl;
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
            }

            let myMoney = pData.money;
            let myDebt = pData.debt || 0;
            let myJob = pData.job || 'サラリーマン';
            let currentMonthlyDebt = (pData.debt_month === thisMonth) ? (pData.monthly_debt || 0) : 0;

            // 2. ブラックリスト防衛
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { 
                await kickTarget(roomId, [senderId], 'readonly'); 
                await cw.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{}); 
                return; 
            }

            // 3. スパム（連投）防衛
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await kickTarget(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 4. 履歴保存 (過去改変用・10%の確率で記録)
            if (gambleActive && Math.random() < 0.1) recordMoneyHistory();

            // 5. 深夜0時リセット & 宝くじ抽選
            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, extra_slots: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    
                    let resetMsg = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\n各種制限がリセットされました！\n[hr]`;
                    
                    const { data: tData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = tData ? JSON.parse(tData.value) : [];
                    if (tickets.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let payouts = {}; let winners = [];
                        
                        const checkPrize = (n, w) => {
                            if (n === w) return { p: 30000, name: '🥇 1等' };
                            let prev = w - 1 < 1 ? 9999 : w - 1; 
                            let next = w + 1 > 9999 ? 1 : w + 1;
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
                            for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${formatNumber(w.p)} コイン)\n`;
                            if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                        } else {
                            resetMsg += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        }
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMessage(roomId, resetMsg + `[/info]`);
                }
            }

            // --- 📖 ヘルプコマンド ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V42 FINAL)[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (1日5回上限)
・ [code]/catch[/code], [code]/goal[/code], [code]/boostslot[/code], [code]/changemaster[/code], [code]/未来改変[/code], [code]/過去改変[/code] : 職業専用能力 (1日1回)
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (1日3回＋α, 上限99,999, ドラゴン30倍)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/cc[/code] : チンチロリン募集 ([code]/roll[/code] でサイコロ)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬1-馬2][/code])

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : ゲーム強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効化/無効化
・ [code]/blacklist[/code] : 追放[/info]`;
                return sendTempMessage(roomId, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let targetAid = repliedAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (targetAid && amt > 0) { 
                    await addMoneyWithRepay(targetAid, amt); 
                    return sendTempMessage(roomId, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${targetAid}] 様へ ${formatNumber(amt)} コインを付与しました。[/info]`); 
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
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ 進行中のゲームはありません。[/info]`);
                }
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
                if (pData && pData.omikuji_date === today) return sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeReplyTag(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${pData.omikuji_result})[/info]`);
                
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

            // --- 🏦 銀行関連 (借金・送金) ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (amt > 99999) return sendTempMessage(roomId, `[info][title]⚠️ 上限エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n借金の上限は 99,999 コインまでです！[/info]`);
                    if (currentMonthlyDebt + amt > 5000) return sendTempMessage(roomId, `[info][title]⚠️ 借金上限エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${currentMonthlyDebt} コイン借りています)[/info]`);
                    
                    await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info][title]💳 お借り入れ完了[/title][piconname:${senderId}] 様\n${formatNumber(amt)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${formatNumber(5000 - (currentMonthlyDebt + amt))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                
                if (targetAid && amt > 0) {
                    let av = Math.max(0, myMoney - myDebt); 
                    if (av < amt) return sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${formatNumber(av)} コインのみです)[/info]`);
                    
                    let tax = Math.floor(amt * 0.10); 
                    let rAmt = amt - tax;
                    
                    await supabase.from('players').update({ money: myMoney - amt }).eq('account_id', senderId);
                    
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                    if (rc) await supabase.from('players').update({ money: rc.money + rAmt }).eq('account_id', targetAid);
                    else await supabase.from('players').insert({ account_id: targetAid, money: rAmt, debt: 0, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' });
                    
                    return sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${formatNumber(amt)} コインを送金しました。\n[hr]※システム税 10% (${formatNumber(tax)} コイン) が引かれ、相手には ${formatNumber(rAmt)} コインが届きました。[/info]`);
                }
            }

            // --- 📊 ステータス & ランキング ---
            if (body.trim() === '/status') {
                if (pData) {
                    const remSlot = Math.max(0, 3 + (pData.extra_slots || 0) - pData.slot_count);
                    const dStr = myDebt > 0 ? `\n💳 借金: -${formatNumber(myDebt)} コイン` : '';
                    return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${formatNumber(myMoney)} コイン${dStr}\n💎 純資産: ${formatNumber(myMoney - myDebt)} コイン\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${pData.work_limit} 回\n⛩️ 今日の運勢: ${pData.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
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
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${formatNumber(net)} コイン ${d.debt>0 ? `(借金:-${formatNumber(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                
                return sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s || 'データなし'}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; 
                const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, '賭博師': 100000, 'マスター': 700000, 'タイムトラベラー': 1000000};
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)
 ▶ [code]/work[/code] (100〜500) ※10%でミス0

🏛️ 公務員 (費用: 2,000)
 ▶ [code]/work[/code] (300〜500)

🚓 警察官 (費用: 3,000)
 ▶ [code]/work[/code] (300〜700)
 ▶ [code]/catch[/code] (30%の確率で犯人逮捕! 800)

⚽ プロスポーツ選手 (費用: 5,000)
 ▶ [code]/work[/code] (500〜1000)
 ▶ [code]/goal[/code] (30%の確率でゴール! 1000)

🎲 賭博師 (費用: 100,000)
 ▶ [code]/work[/code] (3000〜5000)
 ▶ [code]/boostslot[/code] (スロット上限枠+5〜10)

🎩 マスター (費用: 700,000)
 ▶ [code]/work[/code] (1万〜1.5万)
 ▶ [code]/changemaster[/code] (30分間他人の敗北額50%吸収)

⏳ タイムトラベラー (費用: 1,000,000)
 ▶ [code]/work[/code] (1.5万〜2万)
 ▶ [code]/過去改変[/code] (5分前の状態に戻す)
 ▶ [code]/未来改変[/code] (次のゲームが80%で当たる)
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive && pData) {
                if (pData.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で大きなミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${formatNumber(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${formatNumber(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${formatNumber(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${formatNumber(e)} コイン稼ぎました！⚽`; }
                else if(myJob === '賭博師'){ e=Math.floor(Math.random()*2001)+3000; m=`イカサマを見抜き、 ${formatNumber(e)} コイン稼ぎました！🎲`; }
                else if(myJob === 'マスター'){ e=Math.floor(Math.random()*5001)+10000; m=`カジノの売上から ${formatNumber(e)} コインを回収しました！🎩`; }
                else if(myJob === 'タイムトラベラー'){ e=Math.floor(Math.random()*5001)+15000; m=`未来から ${formatNumber(e)} コインを持ってきました！⏳`; }
                
                await supabase.from('players').update({ work_limit: pData.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${pData.work_limit - 1} 回)[/info]`);
            }

            if (/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/.test(body) && gambleActive && pData) {
                let sk = body.match(/(^|\n)\/(catch|goal|boostslot|changemaster|過去改変|未来改変)\b/)[2];
                if (sk === 'catch' && myJob !== '警察官') return sendTempMessage(roomId, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (sk === 'goal' && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (sk === 'boostslot' && myJob !== '賭博師') return sendTempMessage(roomId, `[info]⚠️ 賭博師専用のコマンドです！[/info]`);
                if (sk === 'changemaster' && myJob !== 'マスター') return sendTempMessage(roomId, `[info]⚠️ マスター専用のコマンドです！[/info]`);
                if ((sk === '過去改変' || sk === '未来改変') && myJob !== 'タイムトラベラー') return sendTempMessage(roomId, `[info]⚠️ タイムトラベラー専用のコマンドです！[/info]`);
                
                if (pData.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n今日の特殊能力はすでに使用済みです！[/info]`);
                
                let m = "";
                if (sk === 'catch') { 
                    let sc = Math.random() < 0.3; let e = sc ? 800 : 0; 
                    if(sc){ m=`見事犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; await addMoneyWithRepay(senderId, e); } else m=`犯人を逃してしまいました...🏃‍♂️💨`; 
                } else if (sk === 'goal') { 
                    let sc = Math.random() < 0.3; let e = sc ? 1000 : 0; 
                    if(sc){ m=`スーパーゴールを決めました！スポンサーから ${e} コイン獲得！🥅✨`; await addMoneyWithRepay(senderId, e); } else m=`シュートは外れてしまいました...🤦‍♂️`; 
                } else if (sk === 'boostslot') {
                    let ex = Math.floor(Math.random() * 6) + 5;
                    await supabase.from('players').update({ extra_slots: (pData.extra_slots || 0) + ex }).eq('account_id', senderId);
                    m = `イカサマの準備が整いました...！本日のスロット上限が ${ex} 回増加します！🎲`;
                } else if (sk === 'changemaster') {
                    if (Math.random() < 0.5) {
                        await supabase.from('config').upsert({ key: 'master_buff', value: JSON.stringify({ aid: senderId, expire: Date.now() + 1800000 }) });
                        m = `成功！これから30分間、他人が負けた掛け金の50%を吸収します...！🎩`;
                    } else m = `失敗...今日は調子が悪いようです。🤦‍♂️`;
                } else if (sk === '未来改変') {
                    await supabase.from('config').upsert({ key: 'mirai_buff', value: senderId });
                    m = `✨ 次のゲームで80%の確率で当たるように未来を書き換えました...！⏳`;
                } else if (sk === '過去改変') {
                    const { data: hD } = await supabase.from('config').select('value').eq('key', 'money_history').single();
                    if (hD && hD.value) {
                        let hist = JSON.parse(hD.value);
                        if (hist.length > 0) {
                            let oldest = hist[0].states; 
                            for (let op of oldest) { await supabase.from('players').update({ money: op.money }).eq('account_id', op.account_id); }
                            m = `🕰️ 過去を改変し、5分前の状態（賭けがなかった世界）に戻しました...！`;
                        } else m = `戻すべき過去の記録がありませんでした...`;
                    }
                }
                
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive && pData) {
                let maxS = 3 + (pData.extra_slots || 0);
                if (pData.slot_count >= maxS) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限に達しました！[/info]`);
                if (Date.now() - Number(pData.last_slot_time || 0) < 120000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(2分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? myMoney : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                if (bet > 99999) return sendTempMessage(roomId, `[info]⚠️ 賭け上限は 99,999 コインです！[/info]`);
                
                if (bet > 0 && myMoney >= bet) {
                    await supabase.from('players').update({ money: myMoney - bet, slot_count: pData.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', senderId);
                    
                    let r = Math.random() * 100, omi = (pData.omikuji_date === today) ? pData.omikuji_result : null, oM = "";
                    const isMirai = await consumeMiraiBuff(senderId);
                    
                    if (isMirai) { r = 0; oM = "(🌟未来改変!)"; }
                    else {
                        if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉!)"; } 
                        else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉)"; } 
                        else if(omi === '凶') { r += 0.05; } 
                        else if(omi === '大凶') { r += 0.09; }
                    }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=30; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (30倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; 
                    if (wA > 0) { await addMoneyWithRepay(senderId, wA); } else { await applyMasterTax(bet); }
                    
                    return sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeRp(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り: ${maxS - (pData.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${cnt}枚 = ${formatNumber(cost)} コイン)[/info]`);
                    
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

            // --- 🎲 テーブルゲーム (募集・参加・開始・退出) ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                
                let t = body.includes('/derby') ? 'derby' : (body.includes('/cc') ? 'cc' : 'chouhan');
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : (t==='cc' ? "🎲 チンチロリン" : "🎲 丁半ゲーム"); 
                let ex = t==='derby' ? "[code]/join derby[/code]" : (t==='cc' ? "[code]/join cc[/code]" : "[code]/join chouhan[/code]");
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; 
                    gameState[roomId].oddsStr = dO.oddsStr; 
                    gameState[roomId].st = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※ホストが [code]/start${t === 'chouhan' ? 'chouhan' : t}[/code] で開始します。[/info]`); 
                return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) { 
                    gameState[roomId].players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                if (gameState[roomId].players.length < 2) return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                
                gameState[roomId].state = 'BETTING';
                if (gameState[roomId].type === 'derby') {
                    let ex = `\n【 🐎 馬連オッズ 】\n${gameState[roomId].oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                    await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                    startGameTimer(roomId, 120000, true);
                } else {
                    let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                    await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                    startGameTimer(roomId, 60000);
                }
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
                        clearTimeout(gameState[roomId].timeoutId); 
                        if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
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

        } catch (error) { console.error(error); }
    })();
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

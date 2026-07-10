const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// 生のBodyデータを取得するミドルウェア（署名検証に必須）
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// --- API クライアント初期化 ---
const chatworkAPI = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: {
        'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- グローバル状態管理 ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; // 全ゲームの進行状況管理

let betLogs = [];   // /KK (タイムトラベル) 用の過去5分ログ
let cmState = null; // /cm (マスター) の吸収状態 { accountId, expireTime }
let mkState = null; // /MK (タイムトラベラー) のイカサマ状態 { accountId }

// 起動時にギャンブルの有効/無効状態を取得
supabase.from('config').select('value').eq('key', 'gamble_active').maybeSingle()
    .then(result => { if (result && result.data) gambleActive = result.data.value === 'true'; })
    .catch(error => console.error("Config Load Error:", error.message));

// --- ユーティリティ関数 ---
const getTodayString = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthString = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNum = (num) => Number(num).toLocaleString();

const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature || !req.rawBody || !process.env.CHATWORK_WEBHOOK_TOKEN) {
        console.error("署名検証失敗: ヘッダーまたはトークンが存在しません。");
        return false;
    }
    const expectedSignature = crypto
        .createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64'))
        .update(req.rawBody)
        .digest('base64');
    
    if (signature !== expectedSignature) {
        console.error("署名検証失敗: 署名が一致しません。");
        return false;
    }
    return true;
};

// --- Chatwork メッセージ送受信 ---
const makeReplyTag = (accountId, roomId, messageId) => `[rp aid=${accountId} to=${roomId}-${messageId}]`;

const sendMessage = async (roomId, text) => {
    try {
        const params = new URLSearchParams();
        params.append('body', text);
        await chatworkAPI.post(`/rooms/${roomId}/messages`, params.toString());
    } catch (error) {
        console.error("sendMessage Error:", error.response ? error.response.data : error.message);
    }
};

const sendTempMessage = async (roomId, text, delayMs = 60000) => {
    try {
        const params = new URLSearchParams();
        params.append('body', text);
        const response = await chatworkAPI.post(`/rooms/${roomId}/messages`, params.toString());
        
        if (response && response.data && response.data.message_id) {
            setTimeout(() => {
                chatworkAPI.delete(`/rooms/${roomId}/messages/${response.data.message_id}`).catch(() => {});
            }, delayMs);
        }
    } catch (error) {
        console.error("sendTempMessage Error:", error.response ? error.response.data : error.message);
    }
};

// --- お金・借金管理 (自動返済機能) ---
const logBet = (accountId, diffAmount) => {
    if (diffAmount === 0) return;
    betLogs.push({ accountId, diffAmount, time: Date.now() });
    betLogs = betLogs.filter(log => Date.now() - log.time <= 300000); // 過去5分のみ保持
};

const addMoneyWithRepay = async (accountId, amount) => {
    try {
        const { data: player } = await supabase.from('players').select('*').eq('account_id', accountId).maybeSingle();
        let money = player ? player.money : 0;
        let debt = player ? (player.debt || 0) : 0;
        let actualDiff = amount;

        // 稼いだ額から優先して借金を返済する
        if (debt > 0 && amount > 0) {
            let repayAmount = Math.min(debt, amount);
            debt -= repayAmount;
            amount -= repayAmount;
        }
        money += amount;

        if (player) {
            await supabase.from('players').update({ money: money, debt: debt }).eq('account_id', accountId);
        } else {
            await supabase.from('players').insert({ 
                account_id: accountId, money: money, debt: debt, slot_count: 0, work_limit: 5, msg_count: 0, slot_limit: 5, job: 'サラリーマン' 
            });
        }
        logBet(accountId, actualDiff);
    } catch (error) {
        console.error("addMoneyWithRepay Error:", error.message);
    }
};

const applyCM = async (lossAmount) => {
    if (cmState && Date.now() < cmState.expireTime && lossAmount > 0) {
        let absorbAmount = Math.floor(lossAmount * 0.5);
        if (absorbAmount > 0) {
            await addMoneyWithRepay(cmState.accountId, absorbAmount);
            logBet(cmState.accountId, absorbAmount);
        }
    }
};

// --- 管理・防衛機能 ---
const isUserAdmin = async (roomId, accountId) => {
    try {
        const { data } = await chatworkAPI.get(`/rooms/${roomId}/members`);
        if (!data) return false;
        const member = data.find(m => m.account_id.toString() === accountId.toString());
        return member && (member.role === 'admin' || member.role === 'creator');
    } catch(error) {
        console.error("isUserAdmin Error:", error.message);
        return false;
    }
};

const kickTarget = async (roomId, targetAccountIds, action = 'readonly') => {
    try {
        const { data: membersList } = await chatworkAPI.get(`/rooms/${roomId}/members`);
        if (!membersList) return;
        
        let admins = membersList.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = membersList.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = membersList.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let isFound = false;

        for (const accountId of targetAccountIds) {
            let id = accountId.toString();
            if (admins.includes(id) || members.includes(id) || readonlys.includes(id)) {
                isFound = true;
            }
            admins = admins.filter(x => x !== id);
            members = members.filter(x => x !== id);
            readonlys = readonlys.filter(x => x !== id);
            
            if (action === 'readonly') readonlys.push(id);
        }
        if (!isFound) return;

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        
        await chatworkAPI.put(`/rooms/${roomId}/members`, params.toString());
    } catch(error) {
        console.error("kickTarget Error:", error.message);
    }
};

const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(time => now - time <= 5000);
    return (spamRecords[accountId].length >= 10);
};
// --- ゲームエンジン生成関数 ---
const generateDerby = () => {
    let horseStats = [];
    for (let i = 0; i < 6; i++) {
        horseStats.push(Math.random() * 10 + 1);
    }
    
    let combos = [];
    let totalWeight = 0;
    let oddsMap = {};
    let oddsString = "";
    
    for (let i = 1; i <= 5; i++) {
        for (let j = i + 1; j <= 6; j++) {
            let weight = horseStats[i - 1] * horseStats[j - 1];
            combos.push({ comboName: `${i}-${j}`, weight: weight });
            totalWeight += weight;
        }
    }
    
    combos.forEach(combo => {
        let odd = (0.8 / (combo.weight / totalWeight)).toFixed(1);
        if (odd < 1.1) odd = 1.1; 
        if (odd > 150) odd = 150.0;
        oddsMap[combo.comboName] = Number(odd);
    });
    
    Object.keys(oddsMap).sort((a, b) => oddsMap[a] - oddsMap[b]).forEach(key => {
        oddsString += `🐎 ${key} : [code]${oddsMap[key]}倍[/code]\n`;
    });
    
    return { oddsMap, oddsString, horseStats };
};

const getPokerDeck = () => {
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let i = 0; i < ranks.length; i++) {
            deck.push({ suit: s, rank: ranks[i], value: i + 2 });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const r = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[r]] = [deck[r], deck[i]];
    }
    return deck;
};

const evaluatePokerHand = (cards) => {
    let values = cards.map(c => c.value).sort((a, b) => b - a); // 強い順
    let suits = cards.map(c => c.suit);
    
    let isFlush = suits.every(s => s === suits[0]);
    let isStraight = false;
    let straightHigh = 0;
    
    if (values[0] - values[4] === 4 && new Set(values).size === 5) {
        isStraight = true;
        straightHigh = values[0];
    } else if (values.join(',') === "14,5,4,3,2") {
        isStraight = true;
        straightHigh = 5;
    }
    
    let counts = {};
    values.forEach(v => counts[v] = (counts[v] || 0) + 1);
    let countArray = Object.keys(counts).map(k => [parseInt(k), counts[k]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    
    let rankScore = 1, tieBreak = [];
    if (isFlush && isStraight) {
        if (straightHigh === 14) { rankScore = 10; tieBreak = [14]; } 
        else { rankScore = 9; tieBreak = [straightHigh]; } 
    } else if (countArray[0][1] === 4) {
        rankScore = 8; tieBreak = [countArray[0][0], countArray[1][0]]; 
    } else if (countArray[0][1] === 3 && countArray[1][1] === 2) {
        rankScore = 7; tieBreak = [countArray[0][0], countArray[1][0]]; 
    } else if (isFlush) {
        rankScore = 6; tieBreak = values; 
    } else if (isStraight) {
        rankScore = 5; tieBreak = [straightHigh]; 
    } else if (countArray[0][1] === 3) {
        rankScore = 4; tieBreak = [countArray[0][0], countArray[1][0], countArray[2][0]]; 
    } else if (countArray[0][1] === 2 && countArray[1][1] === 2) {
        rankScore = 3; tieBreak = [countArray[0][0], countArray[1][0], countArray[2][0]]; 
    } else if (countArray[0][1] === 2) {
        rankScore = 2; tieBreak = [countArray[0][0], countArray[1][0], countArray[2][0], countArray[3][0]]; 
    } else {
        rankScore = 1; tieBreak = values; 
    }
    
    const names = ["", "ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ", "ロイヤルフラッシュ"];
    const mults = [1, 1, 1, 2, 3, 4, 5, 10, 20, 50, 100];
    return { rankScore, name: names[rankScore], multiplier: mults[rankScore], tieBreak };
};

const comparePoker = (hand1, hand2) => {
    if (hand1.rankScore > hand2.rankScore) return 1;
    if (hand1.rankScore < hand2.rankScore) return -1;
    for (let i = 0; i < hand1.tieBreak.length; i++) {
        if (hand1.tieBreak[i] > hand2.tieBreak[i]) return 1;
        if (hand1.tieBreak[i] < hand2.tieBreak[i]) return -1;
    }
    return 0; // 完全引き分け
};

const drawPokerCards = (deck) => {
    let hand = [];
    for (let i = 0; i < 5; i++) hand.push(deck.pop());
    return { hand, ...evaluatePokerHand(hand) };
};

// --- ゲーム進行・タイマー管理 ---
const startGameTimer = (roomId, durationMs = 60000, isDerby = false) => {
    let game = gameState[roomId];
    if (!game) return;
    
    if (game.timeoutId) clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    
    if (isDerby) {
        game.remindId = setTimeout(() => {
            if (gameState[roomId] && gameState[roomId].state === 'BETTING') {
                sendTempMessage(roomId, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は [code]/bet [額] [馬1-馬2][/code] を入力してください。[/info]`);
            }
        }, durationMs - 60000);
    }
    game.timeoutId = setTimeout(() => handleGameTimeout(roomId), durationMs);
};

const checkGameProgress = async (roomId) => {
    let game = gameState[roomId];
    if (!game || game.state === 'IDLE') return;

    if (game.state === 'BETTING' && game.players.length >= 2 && game.players.every(p => p.betAmount > 0)) {
        if (game.type === 'derby') {
            clearTimeout(game.timeoutId);
            if (game.remindId) clearTimeout(game.remindId);
            await resolveDerby(roomId);
        } else {
            game.state = 'ACTION';
            let instructionText = game.type === 'chouhan' 
                ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" 
                : "親以外は [code]/draw[/code] で手札を引いてください！";
            await sendTempMessage(roomId, `[info][title]🎲 進行フェーズ[/title]全員のベットが完了しました！\n${instructionText}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(roomId, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.length >= 2 && game.players.every(p => p.actionChoice)) {
            await resolveChouhan(roomId);
        }
        if (game.type === 'poker' && game.players.length >= 2 && game.players.filter(x => x.accountId !== game.hostAccountId).every(p => p.pokerResult)) {
            await resolvePoker(roomId);
        }
    }
};

const handleGameTimeout = async (roomId) => {
    let game = gameState[roomId];
    if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        if (game.players.length >= 2) {
            game.state = 'BETTING';
            if (game.type === 'derby') {
                let instruction = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${instruction}\n[hr](※制限2分。残り1分で通知します)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else {
                let instruction = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${instruction}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else {
        let kickedAids = [];
        let activePlayers = [];
        
        for (let player of game.players) {
            let shouldKick = false;
            if (game.state === 'BETTING' && player.betAmount === 0) shouldKick = true;
            if (game.state === 'ACTION') {
                if (game.type === 'chouhan' && !player.actionChoice) shouldKick = true;
                if (game.type === 'poker' && !player.pokerResult && player.accountId !== game.hostAccountId) shouldKick = true;
            }
            
            if (shouldKick) {
                kickedAids.push(player.accountId);
                if (player.betAmount > 0) {
                    await addMoneyWithRepay(player.accountId, player.betAmount);
                }
            } else {
                activePlayers.push(player);
            }
        }
        
        game.players = activePlayers;
        if (kickedAids.length > 0) {
            await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kickedAids.map(aid => `[piconname:${aid}]`).join(' ')}[/info]`);
        }
        
        if (game.players.length < 2) {
            for (let player of game.players) {
                if (player.betAmount > 0) await addMoneyWithRepay(player.accountId, player.betAmount);
            }
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gameState[roomId] = null;
        } else {
            await checkGameProgress(roomId);
        }
    }
};

// --- ゲーム結果精算 ---
const resolvePoker = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    clearTimeout(game.timeoutId);
    
    try {
        let botResult = drawPokerCards(game.deck);
        
        // タイムトラベラーのイカサマ能力 (MK)
        if (mkState && Math.random() < 0.8) {
            let mkPlayer = game.players.find(p => p.accountId === mkState.aid);
            if (mkPlayer) {
                mkPlayer.pokerResult = { rankScore: 10, name: "ロイヤルフラッシュ", multiplier: 100, hand: [], tieBreak: [14] };
            }
            mkState = null;
        }

        let message = `[info][title]🃏 ポーカー 結果発表[/title]【 親 ([piconname:${game.hostAccountId}]) の手札 】\n[ ${botRes.hand.map(c => c.s + c.r).join(' ')} ] ➡ 『 ${botRes.n} 』\n[hr]【 プレイヤー結果 】\n`;
        
        for (let player of game.players) {
            if (player.accountId === game.hostAccountId) continue;
            let res = player.pokerResult || { rankScore: -1, name: "欠席", multiplier: 1, hand: [], tieBreak: [] };
            
            if (res.rankScore === -1) {
                message += `💀 [piconname:${player.accountId}]: 欠席 (没収)\n`;
                await applyCM(player.betAmount);
                continue;
            }
            
            let compare = comparePoker(res, botResult);
            if (compare === 0) {
                await addMoneyWithRepay(player.accountId, player.betAmount);
                message += `😐 [piconname:${player.accountId}]: [${res.hand.map(c => c.s + c.r).join(' ')}] ${res.name} ➡ 引き分け (返金)\n`;
            } else if (compare > 0) {
                let mult = res.multiplier > 0 ? res.multiplier : 1;
                let winAmount = player.betAmount + (player.betAmount * mult);
                await addMoneyWithRepay(player.accountId, winAmount);
                message += `(cracker) [piconname:${player.accountId}]: [${res.hand.map(c => c.s + c.r).join(' ')}] ${res.name} ➡ 勝ち！ (+${fNum(player.betAmount * mult)})\n`;
            } else {
                message += `💀 [piconname:${player.accountId}]: [${res.hand.map(c => c.s + c.r).join(' ')}] ${res.name} ➡ 負け...\n`;
                await applyCM(player.betAmount);
            }
        }
        await sendMessage(roomId, message + "[/info]");
    } catch (error) {
        console.error("Poker Resolve Error:", error.message);
    } finally {
        gameState[roomId] = null;
    }
};

const resolveChouhan = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    clearTimeout(game.timeoutId);
    
    try {
        let dice1 = Math.floor(Math.random() * 6) + 1;
        let dice2 = Math.floor(Math.random() * 6) + 1;
        let sum = dice1 + dice2;
        let result = (sum % 2 === 0) ? 'chou' : 'han';
        
        if (mkState && Math.random() < 0.8) {
            let mkPlayer = game.players.find(p => p.accountId === mkState.aid);
            if (mkPlayer && mkPlayer.actionChoice) {
                result = mkPlayer.actionChoice;
                if (result === 'chou') { dice1 = 2; dice2 = 2; sum = 4; } else { dice1 = 1; dice2 = 2; sum = 3; }
            }
            mkState = null;
        }

        let message = `[info][title]🎲 丁半 結果発表[/title]出目: ${dice1} と ${dice2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』の勝ち！\n[hr]【 プレイヤー結果 】\n`;
        
        for (let player of game.players) {
            if (player.actionChoice === result) {
                await addMoneyWithRepay(player.accountId, player.betAmount * 2);
                message += `(cracker) [piconname:${player.accountId}]: 的中！ (+${fNum(player.betAmount * 2)} コイン)\n`;
            } else {
                message += `💀 [piconname:${player.accountId}]: 予想[${player.actionChoice === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`;
                await applyCM(player.betAmount);
            }
        }
        await sendMessage(roomId, message + "[/info]");
    } catch (error) {
        console.error("Chouhan Resolve Error:", error.message);
    } finally {
        gameState[roomId] = null;
    }
};

const resolveDerby = async (roomId) => {
    let game = gameState[roomId];
    if (!game) return;
    clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    
    try {
        let stats = game.horseStats, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
        
        let rand1 = Math.random() * totalW, sum1 = 0, firstPlace = 1;
        for (let i = 0; i < 6; i++) { sum1 += ws[i]; if (rand1 <= sum1) { firstPlace = i + 1; break; } }
        
        ws[firstPlace - 1] = 0;
        totalW = ws.reduce((a, b) => a + b, 0);
        
        let rand2 = Math.random() * totalW, sum2 = 0, secondPlace = 1;
        for (let i = 0; i < 6; i++) { sum2 += ws[i]; if (rand2 <= sum2) { secondPlace = i + 1; break; } }
        
        let winCombo = firstPlace < secondPlace ? `${firstPlace}-${secondPlace}` : `${secondPlace}-${firstPlace}`;
        
        if (mkState && Math.random() < 0.8) {
            let mkPlayer = game.players.find(p => p.accountId === mkState.aid);
            if (mkPlayer && mkPlayer.actionChoice) {
                winCombo = mkPlayer.actionChoice;
                let pts = winCombo.split('-');
                firstPlace = parseInt(pts[0]);
                secondPlace = parseInt(pts[1]);
            }
            mkState = null;
        }

        let odd = game.oddsMap[winCombo];
        let message = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${firstPlace} 】番と【 ${secondPlace} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
        
        for (let player of game.players) {
            if (player.actionChoice === winCombo) {
                let winAmount = Math.floor(player.betAmount * odd);
                await addMoneyWithRepay(player.accountId, player.betAmount + winAmount);
                message += `(cracker) [piconname:${player.accountId}]: 的中！ (+${fNum(winAmount)} コイン)\n`;
            } else {
                message += `💀 [piconname:${player.accountId}]: 予想[${player.actionChoice}] ➡ はずれ...\n`;
                await applyCM(player.betAmount);
            }
        }
        await sendMessage(roomId, message + "[/info]");
    } catch (error) {
        console.error("Derby Resolve Error:", error.message);
    } finally {
        gameState[roomId] = null;
    }
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', async (req, res) => {
    // 署名検証
    if (!verifySignature(req)) {
        console.error("Webhook Signature Verification Failed.");
        return res.status(401).send('Invalid Signature');
    }
    
    // Chatworkへのタイムアウト防止のため、必ず即座にOKを返す
    res.status(200).send('OK'); 
    
    const event = req.body.webhook_event;
    if (!event || event.webhook_event_type !== 'message_created') return;

    const roomId = event.room_id;
    const body = event.body || "";
    const senderId = event.account_id.toString();
    const messageId = event.message_id;
    const todayStr = getTodayStr();
    const thisMonthStr = getThisMonthStr();

    try {
        // --- 返信タグの解析 ---
        const replyMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
        const repliedAid = replyMatch ? replyMatch[1] : null;

        // 1. ブラックリスト防衛
        const { data: isBanned } = await supabase.from('blacklist').select('*').eq('account_id', senderId).maybeSingle();
        if (isBanned) { 
            await kickTarget(roomId, [senderId], 'readonly'); 
            await cw.delete(`/rooms/${roomId}/messages/${messageId}`).catch(()=>{}); 
            return; 
        }

        // 2. スパム（連投）防衛
        if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
            await kickTarget(roomId, [senderId], 'readonly');
            await sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            return;
        }

        // 3. 深夜0時リセット & 宝くじ抽選
        if (localLastResetDate !== todayStr) {
            const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').maybeSingle();
            if (!configDate || configDate.value !== todayStr) {
                await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
                localLastResetDate = todayStr;
                
                let resetMsg = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事・能力制限がリセットされました！\n[hr]`;
                
                const { data: tData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').maybeSingle();
                let tickets = tData ? JSON.parse(tData.value) : [];
                if (tickets.length > 0) {
                    let win = Math.floor(Math.random() * 9999) + 1;
                    resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                    let payouts = {}, winners = [];
                    
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
                        for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${fNum(w.p)} コイン)\n`;
                        if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                    } else {
                        resetMsg += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                    }
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                }
                await sendMessage(roomId, resetMsg + `[/info]`);
            }
        }

        // 4. プレイヤーデータ取得 & 仕事回数サイレント回復
        let { data: player } = await supabase.from('players').select('*').eq('account_id', senderId).maybeSingle();
        
        if (!player) {
            player = { account_id: senderId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 1, slot_limit: 5, job: 'サラリーマン' };
            await supabase.from('players').insert(player);
        } else if (gambleActive && !body.startsWith('/')) {
            let msgCount = (player.msg_count || 0) + 1; 
            let workLimit = player.work_limit || 5;
            if (msgCount >= (Math.floor(Math.random() * 21) + 30)) { msgCount = 0; if (workLimit < 10) workLimit++; }
            player.msg_count = msgCount; 
            player.work_limit = workLimit;
            await supabase.from('players').update({ msg_count: msgCount, work_limit: workLimit }).eq('account_id', senderId);
        }

        let myMoney = player.money || 0;
        let myDebt = player.debt || 0;
        let myJob = player.job || 'サラリーマン';
        let currentMonthlyDebt = (player.debt_month === thisMonthStr) ? (player.monthly_debt || 0) : 0;
        let mySlotLimit = player.slot_limit || 5;

        // --- 📖 ヘルプコマンド ---
        if (body.trim() === '/help-gya') {
            const helpText = `[info][title]🎰 カジノ＆ライフ 総合案内 (V42 PERFECT FINAL)[/title]
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
・ [code]/slot [掛金|max|half][/code] : スロット (2分間隔)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/poker[/code] : ポーカー募集 ([code]/draw[/code] で手札を引く)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬1-馬2][/code])
※放置用: [code]/leave[/code] または [code]/fi-game[/code]

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/fi-game[/code] : 進行中のゲームを強制終了・返金
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効/無効化
・ [code]/blacklist[/code], [code]/remove-rank[/code] 等[/info]`;
            await sendTempMessage(roomId, helpText, 120000);
            return;
        }

        // --- 👑 管理者コマンド ---
        if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
            let amount = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
            let targetAid = repliedAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
            if (targetAid && amount > 0) { 
                await addMoneyWithRepay(targetAid, amount); 
                await sendTempMessage(roomId, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${targetAid}] 様へ ${fNum(amount)} コインを付与しました。[/info]`); 
            }
            return;
        }

        if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
            if (gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                for (let p of gameState[roomId].players) {
                    if (p.betAmount > 0) await addMoneyWithRepay(p.aid, p.betAmount);
                }
                if (gameState[roomId].timeoutId) clearTimeout(gameState[roomId].timeoutId); 
                if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                gameState[roomId] = null; 
                await sendTempMessage(roomId, `[info][title]⚠️ ゲーム強制終了[/title]管理者により進行中のゲームが強制終了・全額返金されました。[/info]`);
            } else {
                await sendTempMessage(roomId, `[info]⚠️ 進行中のゲームはありません。[/info]`);
            }
            return;
        }

        if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(roomId, senderId)) {
            let targetAid = repliedAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
            let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
            if (!targetAid && cmd !== 'add') return; 
            if (!targetAid && cmd === 'add') cmd = 'list';

            if (cmd === 'rank') {
                const { data: configData } = await supabase.from('config').select('value').eq('key','rank_excluded').maybeSingle();
                let excludedList = configData ? JSON.parse(configData.value) : [];
                if (excludedList.includes(targetAid)) { 
                    excludedList = excludedList.filter(i => i !== targetAid); 
                    await sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様のランキング除外を解除しました。[/info]`); 
                } else { 
                    excludedList.push(targetAid); 
                    await sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様をランキングから除外しました。[/info]`); 
                }
                await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(excludedList)});
                return;
            }
            
            if (cmd === 'add') { 
                await supabase.from('blacklist').insert({account_id: targetAid}); 
                await kickTarget(roomId, [targetAid], 'readonly'); 
                await sendTempMessage(roomId, `[info][title]🚫 追放完了[/title][piconname:${targetAid}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`); 
            } else if (cmd === 'remove') { 
                await supabase.from('blacklist').delete().eq('account_id', targetAid); 
                await sendTempMessage(roomId, `[info][title]✅ 解除完了[/title][piconname:${targetAid}] の追放状態を解除しました。[/info]`); 
            } else if (cmd === 'list') { 
                const { data: blacklistData } = await supabase.from('blacklist').select('account_id'); 
                const listStr = blacklistData && blacklistData.length ? blacklistData.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし";
                await sendTempMessage(roomId, `[info][title]📜 ブラックリスト一覧[/title]${listStr}\n[hr]※1分後に自動消滅します[/info]`); 
            }
            return;
        }

        if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) { 
            gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); 
            await sendMessage(roomId, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); 
            return;
        }
        if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) { 
            gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); 
            await sendMessage(roomId, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); 
            return;
        }

        // --- ⛩️ おみくじ ---
        if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
            if (player && player.omikuji_date === todayStr) {
                await sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeRp(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${player.omikuji_result})[/info]`);
                return;
            }
            let rand = Math.random() * 100, res = "", eff = "";
            if(rand < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP (0.5%)】！"; } 
            else if(rand < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP (0.3%)】！"; } 
            else if(rand < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通り(0.1%)です。"; } 
            else if(rand < 85) { res = "吉"; eff = "🎯 スロット確率は通常通り(0.1%)です。"; } 
            else if(rand < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
            else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN (0.01%)】..."; }
            
            await supabase.from('players').update({ omikuji_date: todayStr, omikuji_result: res }).eq('account_id', senderId);
            await sendMessage(roomId, `[info][title]⛩️ おみくじ結果[/title]${makeRp(senderId, roomId, msgId)}\n[hr]今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            return;
        }

        // --- 🏦 銀行関連 (借金・送金) ---
        const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
        if (debtMatch && gambleActive) {
            let amount = parseInt(debtMatch[2], 10);
            if (amount > 0) {
                if (currentMonthlyDebt + amount > 5000) {
                    await sendTempMessage(roomId, `[info][title]⚠️ 借金上限エラー[/title]${makeRp(senderId, roomId, msgId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${currentMonthlyDebt} コイン借りています)[/info]`);
                } else {
                    await supabase.from('players').update({ money: myMoney + amount, debt: myDebt + amount, monthly_debt: currentMonthlyDebt + amount, debt_month: thisMonthStr }).eq('account_id', senderId);
                    await sendTempMessage(roomId, `[info][title]💳 お借り入れ完了[/title][piconname:${senderId}] 様\n${fNum(amount)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (currentMonthlyDebt + amount))} コイン[/info]`);
                }
            }
            return;
        }

        if (/(^|\n)\/give/.test(body) && gambleActive) {
            let targetAid = repliedAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
            let amount = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
            
            if (targetAid && amount > 0) {
                let available = Math.max(0, myMoney - myDebt); 
                if (available < amount) {
                    await sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeRp(senderId, roomId, msgId)}\n送金枠(純資産)が不足しています！\n(送金可能額: ${fNum(available)} コイン)[/info]`);
                } else {
                    let tax = Math.floor(amount * 0.10); let receiveAmt = amount - tax;
                    await supabase.from('players').update({ money: myMoney - amount }).eq('account_id', senderId);
                    
                    const { data: targetPlayer } = await supabase.from('players').select('*').eq('account_id', targetAid).maybeSingle();
                    if (targetPlayer) await supabase.from('players').update({ money: targetPlayer.money + receiveAmt }).eq('account_id', targetAid);
                    else await supabase.from('players').insert({ account_id: targetAid, money: receiveAmt, debt: 0, slot_count: 0 });
                    
                    await sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${fNum(amount)} コインを送金しました。\n[hr]※システム税 10% (${fNum(tax)} コイン) が引かれ、相手には ${fNum(receiveAmt)} コインが届きました。[/info]`);
                }
            }
            return;
        }

        // --- 📊 ステータス & ランキング ---
        if (body.trim() === '/status') {
            const remainSlot = Math.max(0, mySlotLimit - player.slot_count);
            const debtString = myDebt > 0 ? `\n💳 借金: -${fNum(myDebt)} コイン` : '';
            await sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${fNum(myMoney)} コイン${debtString}\n💎 純資産: ${fNum(myMoney - myDebt)} コイン\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remainSlot} 回\n💼 お仕事残り: ${player.work_limit} 回\n⛩️ 今日の運勢: ${player.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
            return;
        }

        if (body.trim() === '/money-rank') {
            const { data: excData } = await supabase.from('config').select('value').eq('key','rank_excluded').maybeSingle(); 
            let excludedAids = excData ? JSON.parse(excData.value) : [];
            const { data: allPlayers } = await supabase.from('players').select('*'); 
            let filteredPlayers = allPlayers ? allPlayers.filter(d => !excludedAids.includes(d.account_id)) : [];
            
            filteredPlayers.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
            let rankString = filteredPlayers.slice(0, 10).map((d, i) => {
                let netWealth = (d.money||0) - (d.debt||0); 
                let medal = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                return `${medal} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(netWealth)} コイン ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
            }).join('\n[hr]');
            
            await sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${rankString || 'データなし'}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            return;
        }

        // --- 💼 職業機能 ---
        const changeJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手|賭博師|マスター|タイムトラベラー)/);
        if (changeJobMatch && gambleActive) {
            const jobName = changeJobMatch[2]; 
            const jobCosts = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000, '賭博師': 100000, 'マスター': 700000, 'タイムトラベラー': 1000000};
            
            if (myJob === jobName) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nすでに ${jobName} に就いています！[/info]`);
            } else if (myMoney < jobCosts[jobName]) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${fNum(jobCosts[jobName])} コイン)[/info]`);
            } else {
                await supabase.from('players').update({ job: jobName, money: myMoney - jobCosts[jobName] }).eq('account_id', senderId);
                await sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jobName}」としてご活躍ください！ (-${fNum(jobCosts[jobName])} コイン)[/info]`);
            }
            return;
        } else if (body.trim() === '/job' && gambleActive) {
            const jobMsg = `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (0) ➡ [code]/work[/code] (100〜500) ※10%でミス0
🏛️ 公務員 (2,000) ➡ [code]/work[/code] (300〜500)
🚓 警察官 (3,000) ➡ [code]/work[/code] (300〜700) ＆ [code]/catch[/code]
⚽ プロスポーツ (5,000) ➡ [code]/work[/code] (500〜1000) ＆ [code]/goal[/code]
🎲 賭博師 (10万) ➡ [code]/work[/code] (3000〜5000) ＆ [code]/slot-up[/code]
🔮 マスター (70万) ➡ [code]/work[/code] (1万〜1.5万) ＆ [code]/cm[/code]
⏳ タイムトラベラー (100万) ➡ [code]/work[/code] (1.5万〜2万) ＆ [code]/KK[/code], [code]/MK[/code]
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`;
            await sendTempMessage(roomId, jobMsg, 60000);
            return;
        }

        if (/(^|\n)\/work\b/.test(body) && gambleActive) {
            if (player.work_limit <= 0) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
            } else if (Date.now() - (player.last_work_time || 0) < 600000) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
            } else {
                let earn = 0, message = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ earn=0; message="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { earn=Math.floor(Math.random()*401)+100; message=`真面目に働き、 ${fNum(earn)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ earn=Math.floor(Math.random()*201)+300; message=`安定した仕事をこなし、 ${fNum(earn)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ earn=Math.floor(Math.random()*401)+300; message=`街の平和を守り、 ${fNum(earn)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ earn=Math.floor(Math.random()*501)+500; message=`試合で大活躍し、 ${fNum(earn)} コイン稼ぎました！⚽`; }
                else if(myJob === '賭博師'){ earn=Math.floor(Math.random()*2001)+3000; message=`ギャンブルの合間に、 ${fNum(earn)} コイン稼ぎました！🎲`; }
                else if(myJob === 'マスター'){ earn=Math.floor(Math.random()*5001)+10000; message=`究極の指導を行い、 ${fNum(earn)} コイン稼ぎました！🔮`; }
                else if(myJob === 'タイムトラベラー'){ earn=Math.floor(Math.random()*5001)+15000; message=`時空を超えて、 ${fNum(earn)} コインを調達しました！⏳`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, earn); 
                await sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${message}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }
            return;
        }

        if (/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/.test(body) && gambleActive) {
            let cmd = body.match(/(^|\n)\/(catch|goal|slot-up|cm|MK|KK)\b/)[2];
            if (cmd === 'catch' && myJob !== '警察官') return; 
            if (cmd === 'goal' && myJob !== 'プロスポーツ選手') return;
            if (cmd === 'slot-up' && myJob !== '賭博師') return; 
            if (cmd === 'cm' && myJob !== 'マスター') return;
            if ((cmd === 'KK' || cmd === 'MK') && myJob !== 'タイムトラベラー') return;

            if (player.skill_date === todayStr) {
                await sendTempMessage(roomId, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                return;
            }
            
            let message = "";
            if (cmd === 'catch') {
                if (Math.random() < 0.3) { await addMoneyWithRepay(senderId, 800); message = `犯人を逮捕しました！特別報酬 800 コイン獲得！🚨`; }
                else message = `犯人を逃してしまいました...🏃‍♂️💨`;
            } else if (cmd === 'goal') {
                if (Math.random() < 0.3) { await addMoneyWithRepay(senderId, 1000); message = `スーパーゴールを決めました！特別報酬 1000 コイン獲得！🥅✨`; }
                else message = `シュートは外れてしまいました...🤦‍♂️`;
            } else if (cmd === 'slot-up') {
                let newLimit = Math.floor(Math.random() * 6) + 10; 
                await supabase.from('players').update({ slot_limit: newLimit }).eq('account_id', senderId);
                message = `ギャンブル魂が燃え上がった！🔥 本日のスロット上限が ${newLimit} 回にアップしました！`;
            } else if (cmd === 'cm') {
                if (Math.random() < 0.5) { 
                    cmState = { aid: senderId, expire: Date.now() + 30 * 60000 }; 
                    message = `マスターのオーラを展開！🔮\nここから30分間、他人がギャンブルで負けた額の50%を吸収します！`; 
                } else {
                    message = `オーラの展開に失敗しました...今日はもう使えません。💦`;
                }
            } else if (cmd === 'MK') {
                mkState = { aid: senderId }; 
                message = `未来予知完了...👁️✨\n次に行われるゲームで、あなたに80%の確率で「奇跡」が起こります！`;
            } else if (cmd === 'KK') {
                let now = Date.now();
                let targets = betLogs.filter(l => now - l.time <= 300000);
                let diffs = {};
                for (let l of targets) { 
                    if (!diffs[l.aid]) diffs[l.aid] = 0; 
                    diffs[l.aid] -= l.diff; 
                }
                for (let aid in diffs) { 
                    if (diffs[aid] !== 0) await addMoneyWithRepay(aid, diffs[aid]); 
                }
                betLogs = []; cmState = null; mkState = null;
                message = `⏳ タイムトラベル発動！\n過去5分間にあった全てのギャンブル結果を「なかったこと」にしました！（全プレイヤーの損益が巻き戻りました）`;
            }
            
            await supabase.from('players').update({ skill_date: todayStr }).eq('account_id', senderId);
            await sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}] 様\n\n${message}[/info]`);
            return;
        }

        // --- 🎰 スロット ---
        const slotMatch = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
        if (slotMatch && gambleActive) {
            if (player.slot_count >= mySlotLimit) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n本日のスロットは上限(${mySlotLimit}回)に達しました！[/info]`);
                return;
            }
            if (Date.now() - Number(player.last_slot_time || 0) < 120000) {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nスロット休憩中(2分間隔)です！[/info]`);
                return;
            }
            
            let betAmount = slotMatch[2] === 'max' ? myMoney : (slotMatch[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(slotMatch[2], 10));
            betAmount = Math.min(betAmount, 99999); 
            
            if (betAmount > 0 && myMoney >= betAmount) {
                await supabase.from('players').update({ money: myMoney - betAmount, slot_count: player.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', senderId);
                logBet(senderId, -betAmount); 
                
                // 確率計算（大吉は 0.1% -> 0.5% に変動）
                let randVal = Math.random() * 100;
                let omiResult = (player.omikuji_date === todayStr) ? player.omikuji_result : null;
                let omiMsg = "";
                
                if(omiResult === '大吉') { randVal = Math.max(0, randVal - 0.4); omiMsg = "(⛩️大吉ボーナス!)"; } 
                else if(omiResult === '中吉') { randVal = Math.max(0, randVal - 0.2); omiMsg = "(⛩️中吉ボーナス)"; } 
                else if(omiResult === '凶') { randVal += 0.05; } 
                else if(omiResult === '大凶') { randVal += 0.09; }
                
                if (mkState && mkState.aid === senderId && Math.random() < 0.8) { 
                    randVal = 0.05; mkState = null; omiMsg = "(👁️MK発動!)"; 
                }

                let mult = 0, sym = "", resMsg = "";
                if (randVal < 0.1) { mult=30; sym="🐉 | 🐉 | 🐉"; resMsg="🔥 超大当たり！！！ (30倍) 🔥"; } 
                else if (randVal < 3.1) { mult=10; sym="7️⃣ | 7️⃣ | 7️⃣"; resMsg="✨ 大当たり！ (10倍) ✨"; } 
                else if (randVal < 9.1) { mult=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sym=`${s} | ${s} | ${s}`; resMsg="(cracker) 当たり！ (3倍)"; } 
                else if (randVal < 19.1) { mult=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sym=`${s} | ${s} | ${s}`; resMsg="(cracker) 当たり！ (2倍)"; } 
                else if (randVal < 29.1) { mult=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sym=`${s} | ${s} | ${s}`; resMsg="🍇 フルーツ揃い！ (2倍)"; } 
                else if (randVal < 49.1) { 
                    mult=2; let oth=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; 
                    let s1 = oth[Math.floor(Math.random()*oth.length)];
                    let s2 = oth[Math.floor(Math.random()*oth.length)]; 
                    let arr = ["🍒", s1, s2].sort(()=>Math.random()-0.5); 
                    sym = arr.join(" | "); resMsg = "🍒 チェリー出現！ (2倍)"; 
                } 
                else { 
                    mult=0; let oth=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; 
                    let r1 = oth[Math.floor(Math.random()*oth.length)];
                    let r2 = oth[Math.floor(Math.random()*oth.length)];
                    let r3 = oth[Math.floor(Math.random()*oth.length)]; 
                    while (r1 === r2 && r2 === r3) r3 = oth[Math.floor(Math.random()*oth.length)]; 
                    sym = `${r1} | ${r2} | ${r3}`; resMsg = "💀 はずれ..."; 
                }
                
                let winAmount = betAmount * mult; 
                if (winAmount > 0) { 
                    await addMoneyWithRepay(senderId, winAmount); 
                } else { 
                    await applyCM(betAmount); 
                } 
                
                await sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${omiMsg}[/title]${makeRp(senderId, roomId, msgId)}\n[hr]　▶ [ ${sym} ] ◀　\n[hr]${resMsg}\n\n賭け金: ${fNum(betAmount)} ➡ 獲得: ${fNum(winAmount)} コイン\n(残り回数: ${mySlotLimit - (player.slot_count + 1)}回)[/info]`);
            } else {
                await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }
            return;
        }

        // --- 🎟️ 宝くじ ---
        const lotMatch = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
        if (lotMatch && gambleActive) {
            let mode = lotMatch[2] || 'バラ', count = lotMatch[3] ? parseInt(lotMatch[3], 10) : 1;
            if (count > 0 && count <= 100) {
                let cost = count * 100; 
                if (myMoney < cost) {
                    await sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${count}枚 = ${fNum(cost)} コイン)[/info]`);
                    return;
                }
                
                const { data: configData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').maybeSingle();
                let tickets = configData ? JSON.parse(configData.value) : [];
                let usedNumbers = new Set(tickets.map(t => t.num)); 
                let myNumbers = [];
                
                if (mode === '連番') {
                    let startNum = -1, randStart = Math.floor(Math.random()*(10000 - count)) + 1;
                    for (let i = 0; i < 10000; i++) { 
                        let s = ((randStart + i) % (10000 - count)) + 1; 
                        let isOk = true; 
                        for (let j = 0; j < count; j++) { 
                            if (usedNumbers.has(s + j)) { isOk = false; break; } 
                        } 
                        if (isOk) { startNum = s; break; } 
                    }
                    if (startNum === -1) {
                        await sendTempMessage(roomId, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        return;
                    }
                    for (let j = 0; j < count; j++) myNumbers.push(startNum + j);
                } else {
                    let available = []; 
                    for (let i = 1; i <= 9999; i++) if (!usedNumbers.has(i)) available.push(i);
                    if (available.length < count) {
                        await sendTempMessage(roomId, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        return;
                    }
                    for (let i = available.length - 1; i > 0; i--) { 
                        const r = Math.floor(Math.random() * (i + 1)); 
                        [available[i], available[r]] = [available[r], available[i]]; 
                    } 
                    myNumbers = available.slice(0, count);
                }
                
                await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', senderId);
                logBet(senderId, -cost);
                for (let n of myNumbers) tickets.push({ aid: senderId, num: n });
                await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tickets) });
                
                let numsStr = myNumbers.length > 5 ? myNumbers.slice(0,5).join(', ') + ` ...他${count - 5}枚` : myNumbers.join(', ');
                await sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${senderId}] 様\n宝くじを ${count} 枚（${mode}）購入しました！\n番号: ${numsStr}\n\n(※抽選は深夜0時に行われます)[/info]`);
            }
            return;
        }

        // --- 🎲 テーブルゲーム (募集・参加・開始・退出) ---
        if (body.match(/(^|\n)\/(chouhan|poker|derby)\b/) && gambleActive) {
            if (gameState[roomId]) {
                await sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                return;
            }
            
            let type = body.includes('/derby') ? 'derby' : (body.includes('/poker') ? 'poker' : 'chouhan');
            gameState[roomId] = { type: type, state: 'RECRUITING', hostAccountId: senderId, players: [{ accountId: senderId, betAmount: 0 }] };
            
            let titleName = type === 'derby' ? "🐎 みんなでダービー" : (type === 'poker' ? "🃏 ポーカー" : "🎲 丁半ゲーム"); 
            let joinCmd = type === 'derby' ? "[code]/join derby[/code]" : (type === 'poker' ? "[code]/join poker[/code]" : "[code]/join chouhan[/code]");
            
            if (type === 'derby') {
                let dData = generateDerby(); 
                gameState[roomId].oddsMap = dData.oddsMap; 
                gameState[roomId].oddsStr = dData.oddsStr; 
                gameState[roomId].horseStats = dData.stats;
            } else if (type === 'poker') {
                gameState[roomId].deck = getPokerDeck();
            }
            
            await sendTempMessage(roomId, `[info][title]${titleName} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${joinCmd} と入力！(現在 1人)\n[hr]ホストが [code]/start${type}[/code] と打つとゲームが進行します。[/info]`); 
            return;
        }

        if (body.match(/(^|\n)\/join\s+(chouhan|poker|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
            if (!gameState[roomId].players.find(x => x.accountId === senderId)) { 
                gameState[roomId].players.push({ accountId: senderId, betAmount: 0 }); 
                await sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
            }
            return;
        }

        if (body.match(/(^|\n)\/start(chouhan|poker|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].hostAccountId === senderId) {
            if (gameState[roomId].players.length < 2) {
                await sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                return;
            }
            
            gameState[roomId].state = 'BETTING';
            if (gameState[roomId].type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${gameState[roomId].oddsStr}\n[hr]👉 [code]/bet [額] [馬1-馬2][/code] (例: /bet 100 1-2)\n(制限2分。残り1分でリマインドします)`;
                await sendMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※/bet max 等も可、上限99,999)[/info]`);
                startGameTimer(roomId, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※/bet max 等も可、上限99,999)[/info]`);
                startGameTimer(roomId, 60000);
            }
            return;
        }

        if (body.trim() === '/leave' && gambleActive && gameState[roomId] && gameState[roomId].state !== 'IDLE') {
            let idx = gameState[roomId].players.findIndex(p => p.accountId === senderId);
            if (idx !== -1) {
                let p = gameState[roomId].players[idx]; 
                gameState[roomId].players.splice(idx, 1);
                if (p.betAmount > 0) { 
                    await addMoneyWithRepay(senderId, p.betAmount); 
                    logBet(senderId, p.betAmount); 
                } 
                
                await sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。[/info]`);
                if (gameState[roomId].players.length === 0) { 
                    clearTimeout(gameState[roomId].timeoutId); 
                    if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                    gameState[roomId] = null; 
                    await sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                } else {
                    await checkGameProgress(roomId);
                }
            }
            return;
        }

        // --- 🎲 ゲーム (ベット・アクション処理) ---
        const betMatch = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
        if (betMatch && gambleActive && gameState[roomId]?.state === 'BETTING') {
            let pl = gameState[roomId].players.find(x => x.accountId === senderId);
            if (pl && pl.betAmount === 0) {
                let bet = betMatch[2] === 'max' ? myMoney : (betMatch[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(betMatch[2], 10));
                bet = Math.min(bet, 99999); 
                
                if (bet > 0 && myMoney >= bet) {
                    if (gameState[roomId].type === 'derby') {
                        let horse = betMatch[3]; 
                        if (!horse || !gameState[roomId].oddsMap[horse]) {
                            await sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            return;
                        }
                        pl.actionChoice = horse;
                    }
                    pl.betAmount = bet; 
                    await supabase.from('players').update({ money: myMoney - bet }).eq('account_id', senderId);
                    logBet(senderId, -bet); 
                    
                    await sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${fNum(bet)} コインをベットしました！[/info]`);
                    await checkGameProgress(roomId);
                } else {
                    await sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
                }
            }
            return;
        }

        if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
            let pl = gameState[roomId].players.find(x => x.accountId === senderId);
            if (pl && !pl.actionChoice) { 
                pl.actionChoice = body.trim().slice(1); 
                await sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.actionChoice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                await checkGameProgress(roomId); 
            }
            return;
        }

        if (body.trim() === '/draw' && gambleActive && gameState[roomId]?.type === 'poker' && gameState[roomId].state === 'ACTION') {
            let pl = gameState[roomId].players.find(x => x.accountId === senderId);
            if (pl && !pl.pokerResult && senderId !== gameState[roomId].hostAccountId) {
                pl.pokerResult = drawPokerCards(gameState[roomId].deck); 
                await sendMessage(roomId, `[info]🃏 [piconname:${senderId}] の役: ${pl.pokerResult.name}[/info]`); 
                await checkGameProgress(roomId);
            }
            return;
        }

    } catch (error) { 
        console.error("Critical Error Occurred: ", error); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;

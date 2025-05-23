const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// Create tokens.json if it doesn't exist
const tokensFile = path.join(__dirname, 'tokens.json');
if (!fs.existsSync(tokensFile)) {
  fs.writeFileSync(tokensFile, JSON.stringify([]), 'utf8');
}

// Serve static files from public
app.use(express.static(publicDir));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Enhanced logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, {
    query: req.query,
    headers: req.headers,
    body: req.body
  });
  next();
});

let bots = [];

// Load existing bots from tokens.json
try {
  const data = fs.readFileSync(tokensFile, 'utf8');
  bots = JSON.parse(data);
  console.log(`Loaded ${bots.length} bots from tokens.json`);
} catch (err) {
  console.error('Error reading tokens.json:', err);
}

// TEMP: Hardcoded bot so Facebook can verify the webhook
const DEFAULT_VERIFY_TOKEN = "Hassan";
if (!bots.some(bot => bot.id === "default-bot")) {
  bots.push({
    id: "23926875990311589",
    verifyToken: DEFAULT_VERIFY_TOKEN,
    pageAccessToken: "EAFUBXeZC8wqUBO60G40IBSscAZAhhSaQasr32NdUfy5V3Nb3FC2cBOfQymEHCySkoZCaGsvfV9U2HPu7TZARQ7OUqcFJaDq0xpuUzoZBBq5iLtR9ec3LnH7ZBZAZBFmpQKewZALckUvSSZAeGpirEP2P8zz8y3BrJE3eyu84wO60OHQzUZAAL5cYuGMnFvtHKSnZCohQZCLpCvo3xqEZCxuhkQ0ZCBfhgZCl4EecnvZAKZAF4ZD",
    geminiKey: "AIzaSyCtUBTS9SNg76eJWRquvKRm9Xuj-rJso68"
  });
  saveBots(); // Save the default bot
}

// Save bots to tokens.json
function saveBots() {
  return new Promise((resolve, reject) => {
    fs.writeFile(tokensFile, JSON.stringify(bots, null, 2), 'utf8', (err) => {
      if (err) {
        console.error('Error saving bots:', err);
        reject(err);
      } else {
        console.log('Bots saved to tokens.json');
        resolve();
      }
    });
  });
}

// Endpoint to set up new bots
app.post('/set-tokens', async (req, res) => {
  try {
    const { verifyToken, pageAccessToken, geminiKey, pageId } = req.body;
    
    if (!verifyToken || !pageAccessToken || !geminiKey || !pageId) {
      return res.status(400).send("All fields are required");
    }
    
    // Check if bot with this pageId already exists
    const existingBotIndex = bots.findIndex(bot => bot.pageId === pageId);
    
    const bot = {
      id: `bot_${Date.now()}`,
      pageId,
      verifyToken,
      pageAccessToken,
      geminiKey,
      createdAt: new Date().toISOString()
    };

    if (existingBotIndex >= 0) {
      bots[existingBotIndex] = bot;
      console.log(`🔄 Bot ${bot.id} updated for page ${pageId}`);
    } else {
      bots.push(bot);
      console.log(`✅ Bot ${bot.id} registered for page ${pageId}`);
    }

    await saveBots();
    res.send("✅ Bot configuration saved successfully!");
  } catch (error) {
    console.error('Error in /set-tokens:', error);
    res.status(500).send("Internal server error");
  }
});

// Add DELETE endpoint for bots
app.delete('/delete-bot/:id', async (req, res) => {
  try {
    const botId = req.params.id;
    const initialLength = bots.length;
    
    bots = bots.filter(bot => bot.id !== botId);
    
    if (bots.length < initialLength) {
      await saveBots();
      console.log(`🗑️ Bot ${botId} deleted`);
      res.sendStatus(200);
    } else {
      res.status(404).send('Bot not found');
    }
  } catch (error) {
    console.error('Error deleting bot:', error);
    res.status(500).send('Internal server error');
  }
});

// Enhanced Webhook verification endpoint with detailed debugging
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook Verification Request Received:', {
    mode,
    token,
    challenge,
    allVerifyTokens: bots.map(b => b.verifyToken),
    headers: req.headers,
    ip: req.ip
  });

  // Find any bot that matches the token (not just default bot)
  const matchingBot = bots.find(b => b.verifyToken === token);
  
  if (mode === 'subscribe' && matchingBot) {
    console.log(`✅ Webhook verified for bot ${matchingBot.id}`, {
      pageId: matchingBot.pageId,
      verifyToken: matchingBot.verifyToken
    });
    return res.status(200).send(challenge);
  }

  console.error('❌ Webhook verification failed', {
    reason: !mode ? 'Missing hub.mode' : 
            !token ? 'Missing hub.verify_token' :
            !matchingBot ? 'No matching verify token found' : 'Unknown reason',
    receivedToken: token,
    expectedTokens: bots.map(b => b.verifyToken),
    mode
  });

  res.sendStatus(403);
});

// Enhanced message handling with better error tracking
app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Received webhook event:', {
      headers: req.headers,
      body: req.body
    });
    
    const body = req.body;

    if (body.object !== 'page') {
      console.warn('⚠️ Received non-page object:', body.object);
      return res.sendStatus(404);
    }

    // Process each entry
    for (const entry of body.entry) {
      if (!entry.messaging || !Array.isArray(entry.messaging) || entry.messaging.length === 0) {
        console.log('ℹ️ Entry with no messaging data:', entry.id);
        continue;
      }
      
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender?.id;
      const pageId = entry.id;

      if (!senderId || !pageId) {
        console.error('🚫 Invalid webhook event format:', webhookEvent);
        continue;
      }

      console.log(`🔠 Processing message from sender ${senderId} on page ${pageId}`);
      
      // Find bot by page ID (excluding dummy bot)
      const bot = bots.find(b => b.pageAccessToken !== "DUMMY_TOKEN" && b.pageId === pageId);  

      if (!bot) {  
        console.error(`❌ No bot configuration found for page ID: ${pageId}`, {
          availableBots: bots.filter(b => b.pageAccessToken !== "DUMMY_TOKEN").map(b => b.pageId)
        });  
        continue;
      }  

      if (webhookEvent.message?.text) {  
        console.log(`💬 Received message: "${webhookEvent.message.text}"`);
        try {
          const reply = await generateGeminiReply(webhookEvent.message.text, bot.geminiKey);  
          console.log(`📤 Sending reply: "${reply}"`);
          await sendMessage(senderId, reply, bot.pageAccessToken);  
        } catch (error) {
          console.error('💥 Error processing message:', error);
        }
      } else {
        console.log('ℹ️ Non-text message received:', webhookEvent.message);
      }
    }
    
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('🔥 Unhandled error in webhook handler:', error);
    res.status(500).send('Internal server error');
  }
});

// Generate Gemini AI reply with enhanced error handling
async function generateGeminiReply(userText, geminiKey) {
  try {
    if (!geminiKey || !userText) {
      throw new Error('Missing required parameters');
    }

    console.log('🧠 Generating Gemini reply...');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent({
      contents: [{
        parts: [{
          text: `Your name is KORA AI. Reply with soft vibes:\n\nUser: ${userText}`
        }]
      }]
    });
    
    const response = await result.response;
    if (!response || !response.text) {
      throw new Error('Invalid response from Gemini API');
    }
    
    console.log('✅ Gemini response generated successfully');
    return response.text();
  } catch (e) {
    console.error("❌ Gemini error:", {
      error: e.message,
      stack: e.stack
    });
    return "KORA AI is taking a break. Please try again later.";
  }
}

// Enhanced Facebook message sending with better error reporting
function sendMessage(recipientId, text, accessToken) {
  return new Promise((resolve, reject) => {
    if (!recipientId || !text || !accessToken) {
      return reject(new Error('Missing required parameters'));
    }

    const body = {
      recipient: { id: recipientId },
      message: { text }
    };

    const request = https.request({
      hostname: 'graph.facebook.com',
      path: `/v19.0/me/messages?access_token=${accessToken}`,
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'KORA-AI-Server/1.0'
      }
    });

    request.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          console.log(`📨 Facebook API response:`, {
            statusCode: res.statusCode,
            body: parsedData
          });

          if (res.statusCode >= 400) {
            reject(new Error(`Facebook API error: ${parsedData.error?.message || 'Unknown error'}`));
          } else {
            resolve(parsedData);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Facebook response: ${e.message}`));
        }
      });
    });

    request.on('error', err => {
      console.error("❌ Facebook send error:", {
        error: err.message,
        stack: err.stack
      });
      reject(err);
    });
    
    request.write(JSON.stringify(body));
    request.end();
  });
}

// Endpoint to list all bots (for debugging)
app.get('/bots', (req, res) => {
  res.json({
    bots: bots.filter(bot => bot.pageAccessToken !== "DUMMY_TOKEN"),
    defaultVerifyToken: DEFAULT_VERIFY_TOKEN,
    serverTime: new Date().toISOString()
  });
});

// Serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    botCount: bots.length
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🔥 Global error handler:', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

app.listen(port, () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);
  console.log('🔐 Default verify token:', DEFAULT_VERIFY_TOKEN);
  console.log('🤖 Configured bots:', bots.filter(b => b.pageAccessToken !== "DUMMY_TOKEN").length);
});

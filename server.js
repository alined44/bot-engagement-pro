const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
} catch (e) {
  console.log('Stripe not initialized');
}

const { OpenAI } = require('openai');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('frontend'));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Database
let db;
try {
  db = new sqlite3.Database(process.env.DB_PATH || './bot.db', (err) => {
    if (err) console.log('Database warning:', err);
    else console.log('✓ Database initialized');
  });
} catch (e) {
  console.log('Database not available');
}

// Create users table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    paid BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Routes

// ============ AUTH ROUTES ============

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
      'INSERT INTO users (email, password) VALUES (?, ?)',
      [email, hashedPassword],
      function (err) {
        if (err) {
          return res.status(400).json({ error: 'Email already exists' });
        }

        const token = jwt.sign({ id: this.lastID, email }, process.env.JWT_SECRET);
        res.json({ token, message: 'User created successfully' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (!user) return res.status(400).json({ error: 'User not found' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET);
    res.json({ token, paid: user.paid });
  });
});

// ============ PAYMENT ROUTES ============

// Create Stripe Checkout Session
app.post('/api/payment/checkout', authenticateToken, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price: process.env.PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        userId: req.user.id,
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm payment (webhook would be better in production)
app.post('/api/payment/confirm', authenticateToken, (req, res) => {
  const { sessionId } = req.body;

  // In production, verify with Stripe API
  db.run(
    'UPDATE users SET paid = 1 WHERE id = ?',
    [req.user.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Payment confirmed' });
    }
  );
});

// Test route - mark user as paid (for development only)
app.post('/api/payment/test-pay', authenticateToken, (req, res) => {
  db.run(
    'UPDATE users SET paid = 1 WHERE id = ?',
    [req.user.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Test payment confirmed - access granted!' });
    }
  );
});

// ============ USER ROUTES ============

// Get user status (payment status)
app.get('/api/user/status', authenticateToken, (req, res) => {
  db.get('SELECT paid FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ paid: row ? row.paid : 0 });
  });
});

// ============ BOT ROUTES ============

// Generate suggestions (4 modules)
app.post('/api/bot/generate', authenticateToken, async (req, res) => {
  const { module, content } = req.body;

  // Check if user has paid
  db.get('SELECT paid FROM users WHERE id = ?', [req.user.id], async (err, row) => {
    if (!row || !row.paid) {
      return res.status(403).json({ error: 'Please purchase access first' });
    }

    try {
      const prompts = {
        client: 'Développe l\'idée avec un angle nouveau. Génère 3 commentaires courts (2-3 phrases). Langage simple et authentique comme une vraie personne.',
        collab: 'Renforce l\'idée avec des exemples. Génère 3 commentaires courts (2-3 phrases). Authentique et conversationnel.',
        question: 'Pose 3 questions qui creusent l\'idée. Une par ligne. Simple et curieux.',
        message: 'Prolonge la conversation. Génère 3 commentaires courts (2-3 phrases). Ajoute une vraie observation.',
        objection: 'Valide puis approfondis. Génère 3 commentaires courts (2-3 phrases). Respectueux et constructif.',
      };

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un ami intelligent qui développe et soutient les idées. Génère 3 commentaires authentiques (2-3 phrases chacun). Langage SIMPLE et CONVERSATIONNEL - comme tu parles vraiment à quelqu\'un. Pas de jargon, pas de mots pompeux. Montre que tu as compris l\'idée, développe-la, soutiens-la. Réponds UNIQUEMENT avec les 3 commentaires numérotés.',
          },
          {
            role: 'user',
            content: `${prompts[module]}\n\nContenu:\n${content}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      });

      const suggestions = response.choices[0].message.content;
      res.json({ suggestions });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// ============ IMAGE ANALYSIS ROUTE ============

// Analyze image and generate comments
app.post('/api/bot/analyze-image', authenticateToken, async (req, res) => {
  const { imageBase64 } = req.body;

  // Check if user has paid
  db.get('SELECT paid FROM users WHERE id = ?', [req.user.id], async (err, row) => {
    if (!row || !row.paid) {
      return res.status(403).json({ error: 'Please purchase access first' });
    }

    try {
      // Analyze image with OpenAI Vision
      const imageAnalysis = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                },
              },
              {
                type: 'text',
                text: 'Décris brièvement le contenu, le style et le message clé de cette image.',
              },
            ],
          },
        ],
      });

      const imageDescription = imageAnalysis.choices[0].message.content;

      // Generate comments based on image analysis
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un ami qui répond à une image. Génère 3 commentaires (2-3 phrases chacun) qui montrent que tu as VU l\'image et ce qu\'elle communique. Langage simple et authentique. Parle de ce que ça te fait, ce que tu vois, ce que ça dit. Pas d\'analyse froide. Pas de jargon.',
          },
          {
            role: 'user',
            content: `Image: ${imageDescription}\n\nGénère 3 commentaires authentiques sur cette image (2-3 phrases chacun).\nChaque commentaire:\n1. Montre que tu as vu et compris ce que l\'image communique\n2. Ajoute ce que ça te fait ou une observation personnelle\n3. Ouvre la conversation\n\nExemple pour une image sombre:\n"L\'ambiance de cette image c\'est heavy. Les couleurs sombres et la composition bizarre créent quelque chose de vraiment puissant. Je me demande ce que tu voulais exprimer - c\'est sur la transformation, la douleur, ou juste ce vide qu\'on ressent parfois?"`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      });

      const suggestions = response.choices[0].message.content;
      res.json({ suggestions });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// ============ TEST ROUTE ============
app.get('/', (req, res) => {
  res.json({ status: 'Bot is running!' });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
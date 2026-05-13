const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { OpenAI } = require('openai');
require('dotenv').config();

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
const db = new sqlite3.Database(process.env.DB_PATH || './data/bot.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Database initialized');
});

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
        client: 'ANGLE CRITIQUE. Génère 3 observations sur ce que CE CONTENU pose comme problème ou question. Format ultra-minimaliste (1-2 phrases chacune):\n1. [Un point faible ou une tension logique dans l\'argument]\n2. [Une question que cela soulève]\n3. [Une implication non mentionnée]\nTon: analytique, pas personal. Pas de "je pense", juste l\'observation du sujet.',
        collab: 'ANGLE COMPLÉMENTAIRE. Génère 3 observations sur ce que CE CONTENU oublie ou pourrait enrichir. Format ultra-minimaliste (1-2 phrases chacune):\n1. [Une perspective qui enrichit l\'argument]\n2. [Un exemple ou contexte pertinent]\n3. [Une implication positive]\nTon: constructif, analytique. Pas d\'empathie personnelle, de l\'ajout de valeur au sujet.',
        question: 'ANGLE QUESTIONNAIRE. Pose 3 questions qui révèlent une compréhension PROFONDE du sujet. Format ultra-minimaliste, une par ligne:\n1. "Quand tu dis X, signifies-tu vraiment Y?" ou "Est-ce que cela implique Z?"\n2. "Comment cela se reconcile avec...?"\n3. "Qu\'est-ce que cela suppose sur...?"\nTon: curieux, penseur. Pas de pronoms personnels, juste l\'exploration du sujet.',
        message: 'ANGLE OBSERVATIONNEL. Génère 3 observations clés sur CE CONTENU. Format ultra-minimaliste (1-2 phrases chacune):\n1. [Ce que cela révèle sur le sujet]\n2. [Un détail spécifique qui en dit long]\n3. [Une logique ou pattern que cela expose]\nTon: observateur, lucide. Analyse du contenu, pas de réaction personnelle.',
        objection: 'ANGLE DE NUANCE. Génère 3 observations qui complexifient ou nuancent l\'argument. Format ultra-minimaliste (1-2 phrases chacune):\n1. [Pourquoi ce point est valide, ET ce qu\'il omet]\n2. [Un contexte qui change la perspective]\n3. [Une exception ou limite importante]\nTon: respectueux, nuancé. Pas de personnalisation, juste de l\'analyse réfléchie.',
      };

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un penseur analytique. Génère 3 observations courtes, directes et factuelles. Chaque observation numérotée (1., 2., 3.) et ultra-minimaliste (1-2 phrases). Pas d\'empathie personnelle, juste de l\'analyse du sujet. Réponds UNIQUEMENT avec les 3 observations numérotées, sans autre texte.',
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
            content: 'Tu es un penseur analytique. Analyse l\'image de façon objective et perspicace. Génère 3 observations numérotées (1., 2., 3.), ultra-minimalistes (1-2 phrases chacune). Pas de compliments personnels ni d\'empathie, juste de l\'analyse visuelle et sémantique. Réponds UNIQUEMENT avec les 3 observations numérotées, sans autre texte.',
          },
          {
            role: 'user',
            content: `Voici une analyse du contenu : ${imageDescription}\n\nGénère 3 observations analytiques sur CETTE IMAGE:\n1. Qu\'est-ce que le choix visuel (composition, couleur, style) communique?\n2. Qu\'est-ce que cela révèle sur l\'intention du créateur?\n3. Qu\'est-ce que cela suscite comme réflexion ou question chez le spectateur?\nUltra-court, direct, analytique.`,
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

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT,'0.0.0.0',  () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

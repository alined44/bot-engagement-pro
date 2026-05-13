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
        client: 'Génère 3 observations PRÉCISES (max 1 phrase chacune). Format EXACT:\n1. TENSION: [Nomme UNE contradiction ou faiblesse logique SPÉCIFIQUE dans l\'argument]\n2. QUESTION: [Une seule question qui expose ce qui manque]\n3. IMPLICATION: [Une conséquence NON mentionnée par l\'auteur]\nExemple pour "Les femmes survivent plutôt que vivent":\n1. TENSION: Si survivre est la réalité, comment définir "vivre" concrètement?\n2. QUESTION: Qui bénéficie de ce status quo de survie?\n3. IMPLICATION: Changer cela nécessite des transformations structurelles, pas personnelles.\nZéro empathie personnelle. Juste observation analytique.',
        collab: 'Génère 3 observations qui COMPLÈTENT l\'argument (max 1 phrase chacune). Format EXACT:\n1. PERSPECTIVE OUBLIÉE: [Une facette du sujet que l\'auteur n\'a pas nommée]\n2. EXEMPLE PERTINENT: [Un cas réel ou contexte qui renforce l\'argument]\n3. IMPLICATION POSITIVE: [Ce que cette vérité pourrait transformer]\nExemple:\n1. PERSPECTIVE OUBLIÉE: Le coût économique réel du silence (productivité perdue, santé dégradée).\n2. EXEMPLE: Les données montrent que les femmes qui parlent de leur épuisement recréent des communautés.\n3. IMPLICATION: Nommer le problème est le premier acte de reconstruction.\nPas de "ça m\'a touché". Analyse pure.',
        question: 'Génère 3 questions PRÉCISES (max une ligne chacune). Format EXACT:\n1. "Quand tu dis X, signifies-tu que Y est impossible?"\n2. "Quel événement concret a changé ta perception de cela?"\n3. "Si Y était différent, comment changerait X?"\nExemple:\n1. "Quand tu dis survie, signifies-tu que la joie est impossible?"\n2. "Quel moment a révélé ce décalage entre force et épuisement?"\n3. "Si les structures reconnaissaient l\'épuisement, comment les femmes vivraient différemment?"\nZéro pronoms personnels (je, me, moi).',
        message: 'Génère 3 observations du CONTENU (max 1 phrase chacune). Format EXACT:\n1. RÉVÉLATION: [Ce détail spécifique du message expose quelle réalité]\n2. LOGIQUE SOUS-JACENTE: [Quel système ou pattern cela révèle]\n3. QUESTION GÉNÉRÉE: [Quelle interrogation légitime émerge]\nExemple:\n1. RÉVÉLATION: Le mot "survivre" vs "vivre" expose que la femme ne vit pas.\n2. LOGIQUE: Un système demande la force mais consomme l\'énergie vitale.\n3. QUESTION: Comment inverser ce calcul?\nAnalyse du sujet, pas de la personne.',
        objection: 'Génère 3 observations qui NUANCENT (max 1 phrase chacune). Format EXACT:\n1. VALIDITÉ: [Nomme PRÉCISÉMENT pourquoi cette objection est légitime]\n2. CONTEXTE CACHÉ: [Quel facteur complexifie la situation]\n3. LIMITE: [Qu\'est-ce que cette vérité omet]\nExemple:\n1. VALIDITÉ: C\'est vrai - beaucoup de femmes vivent exactement ainsi.\n2. CONTEXTE: Mais certaines structures rendent cette survie nécessaire pour exister socialement.\n3. LIMITE: Il existe aussi des chemins alternatifs moins visibles.\nRespect analytique, pas de patronage.',
      };

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un analyste qui respecte EXACTEMENT les formats donnés. Rien d\'autre. Pas de préambule. Pas de conclusion. Juste les sections numérotées EXACTEMENT comme demandé. Chaque section: MAX 1 phrase. ZERO pronoms personnels (je, me, moi, mon). ZERO empathie. Analyse pure du sujet.',
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
            content: 'Analyste visuel strict. Respecte EXACTEMENT le format. Pas de préambule. Pas de conclusion. Juste les 3 sections. Chaque section: MAX 1 phrase. ZERO empathie.
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
        client: 'TU ES UN ALLIÉ qui développe l\'idée en la challengeant légèrement. Génère 3 commentaires (2-3 phrases chacun). Langage simple, comme tu parles à un ami.\nChaque commentaire:\n1. Montre que tu as COMPRIS l\'idée centrale\n2. Ajoute UN angle nouveau ou une question qui creuse\n3. Soutiens-la finalement\nExemple pour "Les femmes survivent plutôt que vivent":\n"Ouais ce truc de survivre vs vivre m\'a frappé. Genre on dit qu\'on est fortes mais en réalité on tient à peine. C\'est quoi pour toi la différence entre les deux? Parce que c\'est vrai que beaucoup de femmes vivent comme ça et personne ne parle vraiment du prix."\nTon: Conversationnel. Pas de jargon. Pas de compliments vides.',
        collab: 'TU DÉVELOPPES L\'IDÉE en la renforçant avec des exemples ou des angles. Génère 3 commentaires (2-3 phrases chacun).\nChaque commentaire:\n1. Valide ce que tu as lu\n2. Ajoute UNE perspective ou UN exemple concret\n3. Renforce le message\nExemple:\n"T\'as raison, et en plus je vois ça partout - les femmes qui disent \'je vais bien\' alors qu\'elles sont complètement vides. J\'aime comment tu mets le doigt dessus. Je pense que si plus de gens comprenaient ce décalage, pas mal de choses changeraient."\nTon: Authentique. Supporteur. Pas de jargon.',
        question: 'POSE 3 QUESTIONS qui développent la réflexion. Format simple (une par ligne).\nChaque question:\n1. Montre que tu as compris\n2. Creuse plus profond\n3. Invite à réfléchir ensemble\nExemple:\n"Est-ce que c\'est la même survie partout ou ça dépend des contextes? Parce que je me demande si tout le monde vit ça de la même manière. Et du coup, comment on sort de ce mode-là? Y\'a des femmes qui l\'ont fait?"\nTon: Curieux. Pas condescendant. Authentique.',
        message: 'PROLONGE LA CONVERSATION en ajoutant une vraie contribution. Génère 3 commentaires (2-3 phrases chacun).\nChaque commentaire:\n1. Montre que tu as vraiment lu\n2. Ajoute UN détail, exemple ou observation nouvelle\n3. Ouvre la conversation\nExemple:\n"Ce détail sur le vide intérieur malgré la force extérieure c\'est exactement ce que personne ose dire. J\'ajouterais qu\'en plus y\'a une culpabilité derrière - comme si reconnaître qu\'on survient c\'était accepter qu\'on a échoué. Mais en réalité c\'est juste la réalité."\nTon: Penseur. Simple. Authentique.',
        objection: 'VALIDE PUIS APPROFONDIS. Génère 3 commentaires (2-3 phrases chacun).\nChaque commentaire:\n1. Reconnaît la validité du point\n2. Ajoute UNE nuance ou UN contexte\n3. Ouvre une nouvelle perspective\nExemple:\n"C\'est vrai que beaucoup vivent comme ça. Et en même temps je me demande - c\'est une fatalité ou c\'est quelque chose qu\'on peut vraiment changer? Parce que si on comprend d\'où ça vient, peut-être qu\'on peut agir différemment."\nTon: Respectueux. Constructif. Pas de "mais" qui tue.',
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
            content: 'Tu es un ami qui répond à une image. Génère 3 commentaires (2-3 phrases chacun) qui montrent que tu as VU l\'image et ce qu\'elle communique. Langage simple et authentique. Parle de c
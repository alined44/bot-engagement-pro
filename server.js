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

// Generate suggestions (6 modules)
app.post('/api/bot/generate', authenticateToken, async (req, res) => {
  const { module, content } = req.body;

  // Check if user has paid
  db.get('SELECT paid FROM users WHERE id = ?', [req.user.id], async (err, row) => {
    if (!row || !row.paid) {
      return res.status(403).json({ error: 'Please purchase access first' });
    }

    try {
      const prompts = {
        client: 'Tu es un expert en conversation authentique. Génère 3 commentaires qui NE sont PAS des compliments génériques. Au lieu de "tu as bien dit X", analyse PROFONDÉMENT ce que le post implique, identifie une tension ou une nuance que peu voient, et partage une OBSERVATION PERSONNELLE. Chaque commentaire doit: (1) montrer que tu as COMPRIS le vrai problème derrière le post, (2) ajouter une perspective ou détail nouveau que l\'auteur n\'a pas mentionné mais qui est VRAI, (3) être spécifique et concret (pas juste "c\'est inspirant"), (4) prolonger la réflexion. Ton: penseur, empathique, naturel. 2-4 phrases.',
        collab: 'Génère 3 commentaires de soutien PROFOND (pas juste "merci pour ces paroles"). Chaque commentaire doit: (1) citer un DÉTAIL SPÉCIFIQUE du post qui résonne, (2) nommer l\'ÉMOTION ou la RÉALITÉ sous-jacente (ex: "la solitude derrière le succès"), (3) partager une VÉRITÉ CONNEXE que le post a déverrouillée pour toi, (4) terminer par une OBSERVATION qui élève le débat. Montre une vulnérabilité authentique. 3-5 phrases. Ton: réfléchi, honnête, sensible.',
        question: 'Génère 3 questions qui ne sont PAS basiques. Pose des questions qui: (1) révèlent que tu as PERÇU une TENSION ou une LIMITE dans ce qu\'il/elle dit, (2) viennent d\'une curiosité RÉELLE, presque intime (ce que tu aimerais vraiment savoir), (3) ouvrent une nouvelle dimension du sujet, (4) montrent que tu as réfléchi APRÈS avoir lu. Exemple: "J\'ai remarqué que tu parles de X mais pas de Y... c\'est volontaire?" Une question simple et directe. Ton: curieux, respectueux, penseur.',
        message: 'Génère 3 réponses qui PROLONGENT vraiment la conversation. Chaque réponse doit: (1) citer la personne avec une OBSERVATION spécifique (pas juste "merci"), (2) ajouter une INFORMATION, NUANCE ou EXEMPLE nouveau que seul tu peux ajouter, (3) poser une question qui APPROFONDIT (quelque chose de ciblé, pas générique), (4) créer une vraie CONNEXION émotionnelle. Ton: direct, penseur, montrer que tu as vraiment réfléchi. 3-4 phrases.',
        objection: 'Tu es un expert qui comprend VRAIMENT le doute. Génère 3 réponses qui valident AVANT de proposer. Chaque réponse: (1) nomme EXACTEMENT pourquoi l\'objection est LÉGITIME, (2) ajoute une NUANCE qui montre que c\'est plus complexe, (3) partage une DONNÉE, EXEMPLE ou EXPÉRIENCE qui éclaire autrement, (4) laisse la porte ouverte sans forcer. Ton: respectueux de la peur, honnête, bienveillant. 3-5 phrases. Pas de "mais".',
      };

      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'Tu es un expert en engagement sur les réseaux sociaux. Génère des suggestions courtes, pertinentes et authentiques. Chaque suggestion doit être numérotée (1., 2., 3.). Réponds UNIQUEMENT avec les 3 suggestions numérotées, sans autre texte.',
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
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'Tu es un expert en engagement sur les réseaux sociaux. Génère 3 commentaires authentiques, pertinents et engageants basés sur le contenu. Chaque commentaire doit être numéroté (1., 2., 3.). Réponds UNIQUEMENT avec les 3 commentaires numérotés, sans autre texte.',
          },
          {
            role: 'user',
            content: `Voici une analyse du contenu : ${imageDescription}\n\nGénère 3 commentaires PREMIUM qui: (1) montrent que tu as COMPRIS l'intention/le message derrière l'image, (2) identifient un DÉTAIL spécifique (couleur, composition, choix) qui révèle quelque chose, (3) ajoutent une PERSPECTIVE ou SENTIMENT que l'image provoque (pas juste "c'est beau"), (4) créent une CONNEXION émotionnelle authentique avec le créateur. Ton: observateur, sensible, penseur. 2-4 phrases chacun.`,
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const { GoogleGenAI } = require('@google/genai');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// Setup Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Setup MySQL Connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected to MySQL Database');

    // Auto-migrate schema
    db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    db.query(`ALTER TABLE trips ADD COLUMN user_id INT`, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') {
            console.error('Error adding user_id column:', err);
        }
    });

    db.query(`ALTER TABLE trips ADD COLUMN is_favorite BOOLEAN DEFAULT false`, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding is_favorite:', err);
    });

    db.query(`ALTER TABLE users ADD COLUMN home_city VARCHAR(100)`, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding home_city:', err);
    });

    db.query(`ALTER TABLE users ADD COLUMN is_pro BOOLEAN DEFAULT false`, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding is_pro:', err);
    });

    db.query(`ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500)`, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding avatar_url:', err);
    });
});

// Middleware to authenticate JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'Access Denied: No Token' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Invalid Token' });
        req.user = user;
        next();
    });
};

// AUTH ROUTES
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Missing fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Username exists' });
                return res.status(500).json({ success: false, message: 'DB Error' });
            }
            res.json({ success: true, message: 'User registered successfully!' });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'DB Error' });
        if (results.length === 0) return res.status(400).json({ success: false, message: 'User not found' });

        const user = results[0];
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ success: false, message: 'Invalid password' });

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, username: user.username });
    });
});


// GENERATE TRIP ENDPOINT (Secured)
app.post('/api/generate-trip', authenticateToken, async (req, res) => {
    const { destination, days, budget, interests } = req.body;
    const userId = req.user.id;

    db.query('SELECT home_city FROM users WHERE id = ?', [userId], async (err, pResults) => {
        let homeCityStr = '';
        if (pResults && pResults[0] && pResults[0].home_city) {
            homeCityStr = `\nThe user is departing from: ${pResults[0].home_city}. Include flight or travel contexts from this origin if realistic.`;
        }

        try {
            console.log(`Asking AI: ${days} days in ${destination} | Budget: ${budget} | Interests: ${interests}`);

            const prompt = `Create a detailed ${days}-day travel itinerary for ${destination}. 
            The user has a "${budget}" budget. 
            Their main interests are: ${interests}.${homeCityStr}
            Ensure the activities, dining, and tone reflect this budget and these specific interests.
            You MUST respond ONLY with valid JSON. Do not include any markdown formatting or extra text.
        Structure the JSON exactly like this:
        {
          "title": "A short catchy title for the trip",
          "local_currency": "JPY",
          "center": {
            "lat": 35.6762,
            "lng": 139.6503
          },
          "days": [
            {
              "day": 1,
              "theme": "Focus of the day",
              "activities": ["Activity 1", "Activity 2"]
            }
          ]
        }`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });

        // --- THE UNSTOPPABLE JSON EXTRACTOR ---
        let rawText = response.text;
        console.log("Raw AI Response length:", rawText ? rawText.length : 0); // Debugging

        if (!rawText) {
            throw new Error("No text returned from Gemini API");
        }

        // Find the absolute start and end of the JSON brackets
        const startIndex = rawText.indexOf('{');
        const endIndex = rawText.lastIndexOf('}');

        if (startIndex === -1 || endIndex === -1) {
            throw new Error("The AI did not return a valid JSON object.");
        }

        // Snip out ONLY the good code, leaving the AI's chatty text behind
        let cleanJsonStr = rawText.substring(startIndex, endIndex + 1);

        // Double-check it works
        const parsedData = JSON.parse(cleanJsonStr);

        // Make sure it actually has the 'days' array we need
        if (!parsedData.days || !Array.isArray(parsedData.days)) {
            throw new Error("JSON missing 'days' array");
        }
        // ---------------------------------------

        // ---------------------------------------
        // FETCH UNSPLASH IMAGE
        // ---------------------------------------
        let imageUrl = null;
        try {
            const unsplashUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(destination)}&client_id=${process.env.UNSPLASH_ACCESS_KEY}&per_page=1&orientation=landscape`;
            const imgRes = await fetch(unsplashUrl);
            const imgData = await imgRes.json();
            if (imgData.results && imgData.results.length > 0) {
                imageUrl = imgData.results[0].urls.regular;
            }
        } catch (imgErr) {
            console.error("Unsplash fetch failed:", imgErr);
        }

        // Save to MySQL
        const sql = 'INSERT INTO trips (destination, duration_days, itinerary, user_id) VALUES (?, ?, ?, ?)';
        db.query(sql, [destination, days, cleanJsonStr, userId], (err, result) => {
            if (err) {
                console.error("Database Save Error:", err);
                return res.status(500).json({ success: false, message: 'Failed to save to database.' });
            }
            res.json({ success: true, itinerary: cleanJsonStr, imageUrl });
        });

        } catch (error) {
            console.error("--- AI OR PARSING ERROR ---");
            console.error(error.message);
            res.status(500).json({ success: false, message: 'The AI returned invalid data. Please try again.' });
        }
    });
});

// GET TRIP HISTORY ENDPOINT (Secured)
app.get('/api/history', authenticateToken, (req, res) => {
    try {
        const sql = 'SELECT id, destination, duration_days, created_at, is_favorite, itinerary FROM trips WHERE user_id = ? ORDER BY is_favorite DESC, created_at DESC LIMIT 15';
        db.query(sql, [req.user.id], (err, results) => {
            if (err) return res.status(500).json({ success: false, message: 'Failed to fetch history' });
            res.json({ success: true, trips: results });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET USER PROFILE ENDPOINT (Secured)
app.get('/api/profile', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const profileSql = 'SELECT username, created_at, home_city, is_pro, avatar_url FROM users WHERE id = ?';
    db.query(profileSql, [userId], (err, userResults) => {
        if (err || userResults.length === 0) return res.status(500).json({ success: false, message: 'User not found' });
        
        const countSql = 'SELECT COUNT(*) as totalTrips FROM trips WHERE user_id = ?';
        db.query(countSql, [userId], (err, countResults) => {
            if (err) return res.status(500).json({ success: false, message: 'Stats error' });
            
            res.json({
                success: true,
                username: userResults[0].username,
                created_at: userResults[0].created_at,
                home_city: userResults[0].home_city || '',
                is_pro: userResults[0].is_pro,
                avatar_url: userResults[0].avatar_url || '',
                totalTrips: countResults[0].totalTrips
            });
        });
    });
});

// POST USER SETTINGS (Secured)
app.post('/api/settings', authenticateToken, (req, res) => {
    const { home_city, avatar_url } = req.body;
    let updates = [];
    let params = [];
    
    if (home_city !== undefined) {
        updates.push('home_city = ?');
        params.push(home_city);
    }
    if (avatar_url !== undefined) {
        updates.push('avatar_url = ?');
        params.push(avatar_url);
    }
    
    if (updates.length === 0) return res.json({ success: true });
    
    params.push(req.user.id);
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    
    db.query(sql, params, (err) => {
        if (err) return res.status(500).json({ success: false, message: 'DB Error' });
        res.json({ success: true });
    });
});

// POST UPGRADE TO PRO (Secured)
app.post('/api/upgrade', authenticateToken, (req, res) => {
    db.query('UPDATE users SET is_pro = true WHERE id = ?', [req.user.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'DB Error' });
        res.json({ success: true });
    });
});

// POST TOGGLE FAVORITE (Secured)
app.post('/api/favorite/:id', authenticateToken, (req, res) => {
    const sql = 'UPDATE trips SET is_favorite = NOT is_favorite WHERE id = ? AND user_id = ?';
    db.query(sql, [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'DB Error' });
        res.json({ success: true });
    });
});

app.listen(3000, () => console.log('Server running on port 3000'));
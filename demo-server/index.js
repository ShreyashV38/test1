require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const { predictBinOverflow } = require('./predictionEngine');
const { generateRoute } = require('./routeEngine');
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// --- API ROUTES ---

// 1. Root Test
app.get('/', (req, res) => {
    res.send('✅ Smart Waste Server is Running!');
});

// 2. MAIN ROUTE: Get All Bins (Updated to include LID DATA)
app.get('/api/bins/all', async (req, res) => {
    try {
        const query = `
            SELECT 
                b.id AS bin_id,
                a.area_name,
                a.taluka,
                b.latitude,
                b.longitude,
                b.current_fill_percent,
                b.status,
                b.lid_status,
                b.lid_angle,
                b.last_updated
            FROM bins b
            LEFT JOIN areas a ON b.area_id = a.id
            ORDER BY b.current_fill_percent DESC; 
        `;
        
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching bins:", err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// NEW: Get Bins for a SPECIFIC Zone/Admin
app.get('/api/bins', async (req, res) => {
    const { area_id } = req.query; 

    try {
        let query;
        let params = [];

        if (area_id) {
            // Logic: Show bins for a specific area
            // We use LEFT JOIN so we don't lose the bin if the area link is slightly broken
            query = `
                SELECT b.id AS bin_id, a.area_name, b.latitude, b.longitude, 
                       b.current_fill_percent, b.status, b.lid_status, b.lid_angle, b.last_updated
                FROM bins b
                LEFT JOIN areas a ON b.area_id = a.id
                WHERE b.area_id = $1 
                ORDER BY b.current_fill_percent DESC;
            `;
            params = [area_id];
        } else {
            // Logic: Super Admin (Show EVERYTHING)
            // LEFT JOIN ensures "orphan" bins still appear on the map
            query = `
                SELECT b.id AS bin_id, a.area_name, b.latitude, b.longitude, 
                       b.current_fill_percent, b.status, b.lid_status, b.lid_angle, b.last_updated
                FROM bins b
                LEFT JOIN areas a ON b.area_id = a.id
                ORDER BY b.current_fill_percent DESC;
            `;
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 3. UPDATE ROUTE: With Detailed Live Logging
app.post('/api/bins/update', async (req, res) => {
    const { bin_id, fill_percent, lid_status, lid_angle } = req.body;
    
    try {
        // A. Update Current State
        const updateQuery = `
            UPDATE bins 
            SET 
                current_fill_percent = $1,
                lid_status = $2,
                lid_angle = $3,
                last_updated = NOW()
            WHERE id = $4
            RETURNING *;
        `;
        await pool.query(updateQuery, [fill_percent, lid_status, lid_angle, bin_id]);

        // B. Insert History
        const insertHistory = `
            INSERT INTO bin_readings (bin_id, fill_percent, lid_status, lid_angle, recorded_at)
            VALUES ($1, $2, $3, $4, NOW());
        `;
        await pool.query(insertHistory, [bin_id, fill_percent, lid_status, lid_angle]);

        // C. Cleanup Old History
        const cleanupQuery = `
            DELETE FROM bin_readings 
            WHERE bin_id = $1 
            AND id NOT IN (
                SELECT id FROM bin_readings 
                WHERE bin_id = $1 
                ORDER BY recorded_at DESC 
                LIMIT 10
            );
        `;
        await pool.query(cleanupQuery, [bin_id]);
        
        // --- 🔴 LIVE CONSOLE LOGS ---
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] 📡 DATA RECEIVED:`);
        console.log(`   └─ 🗑️  Bin ID:   ${bin_id.substring(0,4)}...`);
        console.log(`   └─ 🌊 Fill:     ${fill_percent}%`);
        console.log(`   └─ 🚪 Lid:      ${lid_status} (${lid_angle}°)`);
        console.log(`   └─ ✅ Action:   Database Updated & History Cleaned`);
        console.log('------------------------------------------------');

        res.json({ message: "Data Synced" });

    } catch (err) {
        console.error("❌ Update Failed:", err.message);
        res.status(500).json({ error: 'Update Failed' });
    }
});

// 4. SETTINGS ROUTE
app.get('/api/settings', async (req, res) => {
    try {
        const query = "SELECT key_name, value_text FROM system_settings";
        const result = await pool.query(query);
        
        const settings = {};
        result.rows.forEach(row => {
            settings[row.key_name] = row.value_text;
        });
        
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});


app.get('/api/bins/predict', async (req, res) => {
    const { bin_id } = req.query;

    try {
        // Fetch raw history (Last 10 readings)
        // We let the Engine filter them, so we fetch slightly more than needed
        const query = `
            SELECT fill_percent, recorded_at, status 
            FROM bin_readings 
            WHERE bin_id = $1 
            ORDER BY recorded_at DESC 
            LIMIT 10;
        `;
        const result = await pool.query(query, [bin_id]);
        
        // Pass raw data to the Deterministic Engine
        const prediction = predictBinOverflow(bin_id, result.rows);

        res.json(prediction);

    } catch (err) {
        console.error("Prediction API Error:", err);
        res.status(500).json({ error: "Prediction Failed", prediction_status: "ERROR" });
    }
});


// 7. GET OPTIMIZED ROUTE (Fixed SQL Join)
app.get('/api/bins/optimized-route', async (req, res) => {
    try {
        const { area_id } = req.query;

        // 🔧 FIX: We use 'JOIN' to get the area name from the 'areas' table
        // We assume the column in your 'areas' table is called 'name' or 'area_name'.
        // If this still fails, check if your areas table uses 'name' or 'area_name' and update the query below.
        const query = `
            SELECT 
                b.id as bin_id, 
                b.latitude, 
                b.longitude, 
                b.current_fill_percent, 
                b.status, 
                a.area_name as area_name 
            FROM bins b
            JOIN areas a ON b.area_id = a.id
            WHERE b.area_id = $1;
        `;
        
        const binResult = await pool.query(query, [area_id]);
        let bins = binResult.rows;

        // 2. Mock History for Prediction
        bins = bins.map(b => ({
            ...b,
            readings: [{ 
                fill_percent: b.current_fill_percent, 
                recorded_at: new Date(), 
                status: b.status 
            }]
        }));

        // 3. Define Driver Start Location (First bin as dummy start)
        const driverLocation = bins.length > 0 
            ? { latitude: bins[0].latitude, longitude: bins[0].longitude }
            : { latitude: 15.458, longitude: 73.834 };

        // 4. Generate Route
        const optimizedRoute = generateRoute(driverLocation, bins);

        res.json(optimizedRoute);

    } catch (err) {
        console.error("Routing Error:", err);
        // This helps us see the exact SQL error in the terminal
        res.status(500).json({ error: 'Routing Failed: ' + err.message });
    }
});


app.listen(port, () => {
    console.log(`🚀 Server listening at http://localhost:${port}`);
});
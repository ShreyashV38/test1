require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { Connector } = require('@google-cloud/cloud-sql-connector'); // Import Connector
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const { predictBinOverflow } = require('./predictionEngine');
const { generateRoute } = require('./routeEngine');

app.use(cors());
app.use(express.json());

// Declare pool variable globally so routes can access it
let pool;

// --- DATABASE CONNECTION FUNCTION ---
async function startServer() {
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
        instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
        ipType: process.env.DB_IP_TYPE || 'PUBLIC',
    });

    pool = new Pool({
        ...clientOpts,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        max: 5 // Optional: Max connections in pool
    });

    // Test the connection
    try {
        await pool.query('SELECT NOW()');
        console.log("✅ Connected to Google Cloud SQL!");
        
        // Start the listener ONLY after DB connects
        app.listen(port, () => {
            console.log(`🚀 Server listening at http://localhost:${port}`);
        });

    } catch (err) {
        console.error("❌ Failed to connect to Cloud SQL:", err);
        connector.close(); // Close connector if init fails
        process.exit(1);
    }
}

// Initialize Server
startServer();

// --- API ROUTES ---

// 1. Root Test
app.get('/', (req, res) => {
    res.send('✅ Smart Waste Server is Running (Cloud SQL Edition)!');
});

// 2. MAIN ROUTE: Get All Bins
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

// 3. UPDATE ROUTE
app.post('/api/bins/update', async (req, res) => {
    const { bin_id, fill_percent, lid_status, lid_angle } = req.body;
    
    try {
        const updateQuery = `
            UPDATE bins 
            SET current_fill_percent = $1, lid_status = $2, lid_angle = $3, last_updated = NOW()
            WHERE id = $4 RETURNING *;
        `;
        await pool.query(updateQuery, [fill_percent, lid_status, lid_angle, bin_id]);

        const insertHistory = `
            INSERT INTO bin_readings (bin_id, fill_percent, lid_status, lid_angle, recorded_at)
            VALUES ($1, $2, $3, $4, NOW());
        `;
        await pool.query(insertHistory, [bin_id, fill_percent, lid_status, lid_angle]);

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
        
        console.log(`[${new Date().toLocaleTimeString()}] 📡 Updated Bin ${bin_id.substring(0,4)}...`);
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
        result.rows.forEach(row => settings[row.key_name] = row.value_text);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 5. PREDICTION ROUTE
app.get('/api/bins/predict', async (req, res) => {
    const { bin_id } = req.query;
    try {
        const query = `
            SELECT fill_percent, recorded_at, status 
            FROM bin_readings 
            WHERE bin_id = $1 ORDER BY recorded_at DESC LIMIT 10;
        `;
        const result = await pool.query(query, [bin_id]);
        const prediction = predictBinOverflow(bin_id, result.rows);
        res.json(prediction);
    } catch (err) {
        console.error("Prediction API Error:", err);
        res.status(500).json({ error: "Prediction Failed", prediction_status: "ERROR" });
    }
});

// 6. OPTIMIZED ROUTE
app.get('/api/bins/optimized-route', async (req, res) => {
    try {
        const { area_id } = req.query;
        const query = `
            SELECT b.id as bin_id, b.latitude, b.longitude, b.current_fill_percent, b.status, a.area_name as area_name 
            FROM bins b
            JOIN areas a ON b.area_id = a.id
            WHERE b.area_id = $1;
        `;
        
        const binResult = await pool.query(query, [area_id]);
        let bins = binResult.rows;

        bins = bins.map(b => ({
            ...b,
            readings: [{ fill_percent: b.current_fill_percent, recorded_at: new Date(), status: b.status }]
        }));

        const driverLocation = bins.length > 0 
            ? { latitude: bins[0].latitude, longitude: bins[0].longitude }
            : { latitude: 15.458, longitude: 73.834 };

        const optimizedRoute = generateRoute(driverLocation, bins);
        res.json(optimizedRoute);

    } catch (err) {
        console.error("Routing Error:", err);
        res.status(500).json({ error: 'Routing Failed: ' + err.message });
    }
});
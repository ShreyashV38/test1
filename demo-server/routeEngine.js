// routeEngine.js
const { predictBinOverflow } = require('./predictionEngine');

// 🔧 CONFIGURATION
const GARBAGE_STATION = { latitude: 15.456, longitude: 73.830 }; // Fixed Dump Yard Location
const CRITICAL_THRESHOLD = 80; // %
const NEXT_COLLECTION_HOURS = 24; // Cycle duration

/**
 * Calculates distance between two coords (Haversine formula)
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ1) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
}

/**
 * Generates the Optimized Route
 * @param {Object} startLocation - { latitude, longitude } (Driver's Loc)
 * @param {Array} bins - List of all bins with their readings
 */
function generateRoute(startLocation, bins) {
    let routeLog = [];
    let selectedBins = [];
    let excludedBins = [];

    // --- STEP 1: BIN SELECTION LOGIC ---
    bins.forEach(bin => {
        // 1. Run Prediction (Re-using your engine)
        const prediction = predictBinOverflow(bin.bin_id, bin.readings || []);
        const predictedTime = prediction.predicted_overflow_at ? new Date(prediction.predicted_overflow_at) : null;
        const now = new Date();
        const nextCycle = new Date(now.getTime() + (NEXT_COLLECTION_HOURS * 60 * 60 * 1000));

        let inclusionReason = null;

        // ❌ EXCLUSION RULES
        if (bin.status === 'BLOCKED') {
            excludedBins.push({ id: bin.bin_id, reason: "BLOCKED_SENSOR" });
            return;
        }
        if (bin.status === 'OFFLINE') {
            excludedBins.push({ id: bin.bin_id, reason: "OFFLINE_NO_DATA" });
            return;
        }

        // ✅ INCLUSION RULES
        if (bin.current_fill_percent >= CRITICAL_THRESHOLD) {
            inclusionReason = "CRITICAL_LEVEL";
        } else if (predictedTime && predictedTime <= nextCycle) {
            inclusionReason = "PREDICTED_OVERFLOW";
        }

        if (inclusionReason) {
            selectedBins.push({ ...bin, reason: inclusionReason });
        } else {
            excludedBins.push({ id: bin.bin_id, reason: "NOT_FULL_ENOUGH" });
        }
    });

    // --- STEP 2: ROUTE CONSTRUCTION (Nearest Neighbor) ---
    // Start at Driver Location
    let currentPos = startLocation;
    let finalRoute = [];
    let unvisited = [...selectedBins];

    // Add Start Point
    finalRoute.push({
        type: 'START',
        name: 'Driver Location',
        latitude: startLocation.latitude,
        longitude: startLocation.longitude
    });

    // Greedily find the next closest bin
    while (unvisited.length > 0) {
        let nearest = null;
        let minDist = Infinity;
        let nearestIdx = -1;

        unvisited.forEach((bin, idx) => {
            const d = getDistance(currentPos.latitude, currentPos.longitude, bin.latitude, bin.longitude);
            if (d < minDist) {
                minDist = d;
                nearest = bin;
                nearestIdx = idx;
            }
        });

        // Move to that bin
        if (nearest) {
            finalRoute.push({
                type: 'COLLECTION_POINT',
                name: nearest.area_name || `Bin #${nearest.bin_id.substring(0,4)}`,
                latitude: nearest.latitude,
                longitude: nearest.longitude,
                reason: nearest.reason,
                fill: nearest.current_fill_percent
            });
            
            // Update current position
            currentPos = { latitude: nearest.latitude, longitude: nearest.longitude };
            
            // Remove from unvisited
            unvisited.splice(nearestIdx, 1);
        }
    }

    // --- STEP 3: ADD GARBAGE STATION (Mandatory End) ---
    finalRoute.push({
        type: 'END',
        name: 'Dump Yard (Station)',
        latitude: GARBAGE_STATION.latitude,
        longitude: GARBAGE_STATION.longitude
    });

    return {
        route_points: finalRoute,
        meta: {
            total_stops: finalRoute.length,
            bins_collected: selectedBins.length,
            bins_skipped: excludedBins.length
        }
    };
}

module.exports = { generateRoute };
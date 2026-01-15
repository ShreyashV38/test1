// predictionEngine.js

// 🔧 SYSTEM CONFIGURATION
const CONFIG = {
    MIN_READINGS: 2,             // Need at least 2 points to draw a line
    FRESHNESS_WINDOW_HOURS: 48,  // Ignore readings older than 2 days
    MAX_TIME_GAP_HOURS: 12,      // If data stops for 12h, don't predict
    JUMP_THRESHOLD: 30,          // Ignore sudden >30% jumps (Likely dumping, not filling)
    MAX_PREDICTION_WINDOW: 168   // Cap prediction at 7 days (168 hours)
};

/**
 * Predicts overflow time using deterministic rate analysis.
 * @param {string} binId - Unique Bin ID
 * @param {Array} history - Ordered list of { fill_percent, recorded_at, status }
 * @returns {Object} Strict JSON format output
 */
function predictBinOverflow(binId, history) {
    const now = new Date();
    
    // 1. Initial Default State
    let result = {
        bin_id: binId,
        current_fill: 0,
        fill_rate_per_hour: 0,
        predicted_overflow_at: null,
        prediction_status: "NOT_ENOUGH_DATA"
    };

    // 2. Basic Validation
    if (!history || history.length === 0) return result;
    
    const latest = history[0]; // Assuming sorted DESC (Newest First)
    result.current_fill = latest.fill_percent;

    // ❗ Edge Case: Bin explicitly marked OFFLINE
    if (latest.status === 'OFFLINE') {
        result.prediction_status = "OFFLINE";
        return result;
    }

    // ❗ Edge Case: Bin explicitly marked BLOCKED
    if (latest.status === 'BLOCKED') {
        result.prediction_status = "BLOCKED";
        return result;
    }

    // 3. Filter Valid Readings
    // Remove old data and non-normal statuses to ensure accurate math
    const validReadings = history.filter(r => {
        const rTime = new Date(r.recorded_at);
        const ageHours = (now - rTime) / (1000 * 60 * 60);
        return (r.status === 'NORMAL' && ageHours <= CONFIG.FRESHNESS_WINDOW_HOURS);
    });

    // ❗ Edge Case: Not enough valid points for a trend
    if (validReadings.length < CONFIG.MIN_READINGS) {
        result.prediction_status = "NOT_ENOUGH_DATA";
        return result;
    }

    // 4. Calculate Rate (The Core Logic)
    // Compare Newest Valid Reading vs Oldest Valid Reading in the window
    const newest = validReadings[0];
    const oldest = validReadings[validReadings.length - 1];

    const timeDiffHours = (new Date(newest.recorded_at) - new Date(oldest.recorded_at)) / (1000 * 60 * 60);
    const fillDiff = newest.fill_percent - oldest.fill_percent;

    // ❗ Edge Case: Zero or Negative Rate (Bin is being emptied or static)
    if (fillDiff <= 0 || timeDiffHours <= 0) {
        result.prediction_status = "VALID"; // Valid calculation, but no overflow risk
        return result;
    }

    // ❗ Edge Case: Sudden Anomaly Jump
    // If fill jumped massive amount in short time, it's not a "rate", it's a "dump"
    if (fillDiff > CONFIG.JUMP_THRESHOLD && timeDiffHours < 1) {
        result.prediction_status = "VALID"; 
        // We return valid status but NULL prediction because rate is unreliable
        return result;
    }

    // Compute Rate
    const rate = fillDiff / timeDiffHours;
    result.fill_rate_per_hour = parseFloat(rate.toFixed(2));

    // 5. Predict Future Overflow
    const remainingCapacity = 100 - newest.fill_percent;
    const hoursToOverflow = remainingCapacity / rate;

    // ❗ Edge Case: Prediction is too far in the future (> 7 days)
    if (hoursToOverflow > CONFIG.MAX_PREDICTION_WINDOW) {
        result.prediction_status = "VALID"; // Valid, just too far to worry about
        return result;
    }

    // Calculate Final Timestamp
    const overflowTime = new Date(new Date(newest.recorded_at).getTime() + (hoursToOverflow * 60 * 60 * 1000));
    
    result.predicted_overflow_at = overflowTime.toISOString();
    result.prediction_status = "VALID";

    return result;
}

module.exports = { predictBinOverflow };
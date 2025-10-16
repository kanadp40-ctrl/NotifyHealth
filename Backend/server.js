const express = require('express');
const cors = require('cors');
// jwt is used for secure session tokens (user/admin authorization)
const jwt = require('jsonwebtoken'); 
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb'); 
const path = require('path'); 
const app = express();
const PORT = process.env.PORT || 3000;

// --- Security Configuration ---
// WARNING: Plain text admin password used as requested.
const JWT_SECRET = 'your_super_secure_jwt_secret_key_001_notifyhealth'; 
const ADMIN_USERNAME = 'admin@nh.com'; 
const ADMIN_PASSWORD = 'SJCHS@123'; 

// --- MongoDB Configuration ---
// Host environment MUST set MONGODB_URI environment variable
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://kanadp40_db_user:VZbWfJV2UGDkFUBH@cluster0.bxizhzx.mongodb.net/";
let dbClient = null;
let campsCollection = null;
let bookingsCollection = null; // Collection for patient bookings
let feedbackCollection = null; // Collection for user feedback

// --- Mock Database (In-Memory Fallback for quick local testing) ---
let nextCampId = 1;
const mockCamps = [
    {
        _id: 'mock-1', 
        name: "Community Vaccination Drive",
        date: "2025-11-15",
        time: "10:00",
        location: "Central Park Community Hall",
        address: "123 Health Ave, City Center",
        mapUrl: "https://maps.app.goo.gl/example1",
        contact: "555-1001",
        details: "Free flu shots and basic health screenings available for all ages.",
        doctors: [
            { name: "Dr. Jane Smith", specialty: "Pediatrics" },
            { name: "Dr. Alex Johnson", specialty: "General Medicine" }
        ], 
        createdBy: "admin"
    }
];
const mockBookings = []; // Mock storage for bookings
const mockFeedback = [ 
    { userId: 'mock-user-1', userName: 'TestUser', rating: 5, comment: 'Great service!', submittedAt: new Date().toISOString() }
];

/**
 * Utility function to generate a unique, readable booking number.
 */
const generateBookingNumber = (campId) => {
    const uuidPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    const datePart = new Date().toISOString().substring(5, 10).replace(/-/g, ''); 
    const campPrefix = String(campId).substring(0, 3).toUpperCase();
    return `NH-${datePart}-${campPrefix}-${uuidPart}`;
};

// Function to connect to MongoDB
async function connectToMongo() {
    if (dbClient) return; // Connection already established

    try {
        const client = new MongoClient(MONGODB_URI, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            // OPTIMIZED CONNECTION SETTINGS FOR SERVERLESS:
            tls: true, // Explicitly enables TLS/SSL, required to fix SSL_alert_number 80
            serverSelectionTimeoutMS: 5000, // Wait max 5s for server discovery
            connectTimeoutMS: 10000,       // Max 10s for connection establishment
        });
        await client.connect();
        dbClient = client;
        const db = client.db("NotifyHealthDB"); 
        campsCollection = db.collection("camps");
        bookingsCollection = db.collection("bookings"); 
        feedbackCollection = db.collection("feedback"); 
        console.log("Connected successfully to MongoDB!");
    } catch (e) {
        console.warn("MongoDB connection failed. Using in-memory storage for CRUD operations.");
        console.error("MongoDB Error:", e.message);
    }
}
// Do not call connectToMongo() directly here in serverless environment.

// Middleware
app.use(cors());
app.use(express.json());

// --- Static File Serving Path (Correct for structure: /Backend/server.js -> /Public) ---
const publicPath = path.join(__dirname, '..', 'Public');

// --- Global Middleware to ensure DB connection is made for every request ---
app.use(async (req, res, next) => {
    // This ensures connection is attempted on every cold start
    if (!dbClient) {
        await connectToMongo();
    }
    next();
});

// --- API Routes (Prefix all API routes with /api) ---

app.get('/api', (req, res) => {
    res.json({ message: "NotifyHealth API Status: Operational" });
});

// --- Authentication Middleware ---

/**
 * Middleware to verify a JWT and attach user info (userId, role) to the request.
 */
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authentication token required.' });
    }

    const token = authHeader.substring(7);

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; 
        next();
    } catch (e) {
        res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

/**
 * Middleware to check if the authenticated user has the 'admin' role.
 */
const isAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }
};


// --- Authentication Routes (Plain Text Admin Login) ---

/**
 * Admin Login: Uses direct string comparison (plain text).
 */
app.post('/api/auth/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ userId: ADMIN_USERNAME, role: 'admin', name: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
        return res.json({ success: true, token, role: 'admin', name: 'Admin' });
    }
    
    res.status(401).json({ success: false, message: 'Invalid Admin Credentials' });
});

/**
 * User Login: Issues a signed JWT upon successful Firebase authentication (handled on frontend).
 */
app.post('/api/auth/user/login', (req, res) => {
    const { uid, userName } = req.body;
    
    const token = jwt.sign({ userId: uid, role: 'user', name: userName }, JWT_SECRET, { expiresIn: '1h' });
    
    return res.json({ 
        success: true, 
        token, 
        role: 'user', 
        name: userName || 'Verified User', 
        userId: uid
    });
});


// --- Camp Management Routes (Protected by Auth Middleware) ---

/**
 * GET All Live Camps (Auth required)
 */
app.get('/api/camps', authMiddleware, async (req, res) => {
    try {
        if (campsCollection) {
            const camps = await campsCollection.find({}).toArray(); 
            return res.json(camps);
        }
        return res.json(mockCamps);
    } catch (e) {
        console.error("Error fetching camps from MongoDB/Mock:", e);
        res.status(500).json({ message: 'Server error fetching camps.' });
    }
});

/**
 * POST New Camp (Admin only)
 */
app.post('/api/camps', authMiddleware, isAdmin, async (req, res) => {
    const { name, date, time, location, address, mapUrl, contact, details, doctors } = req.body; 
    const newCamp = {
        name, 
        date, 
        time: time || 'N/A', 
        location, 
        address, 
        mapUrl, 
        contact: contact || 'N/A', 
        details: details || '',
        doctors: doctors || [], 
        createdBy: req.user.userId, 
        createdAt: new Date().toISOString()
    };

    try {
        if (campsCollection) {
            const result = await campsCollection.insertOne(newCamp);
            newCamp._id = result.insertedId; 
        } else {
            newCamp._id = 'mock-' + nextCampId++;
            mockCamps.push(newCamp);
        }
        res.status(201).json({ message: 'Camp added successfully', camp: newCamp });
    } catch (e) {
        console.error("Error adding camp to MongoDB/Mock:", e);
        res.status(500).json({ message: 'Server error adding camp.' });
    }
});

/**
 * PUT Edit Existing Camp (Admin only)
 */
app.put('/api/camps/:id', authMiddleware, isAdmin, async (req, res) => {
    const id = req.params.id;
    const updates = req.body;
    delete updates._id; 

    try {
        if (campsCollection) {
            const result = await campsCollection.updateOne(
                { _id: new ObjectId(id) }, 
                { $set: updates }
            );
            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Camp not found.' });
            }
        } else {
            const campIndex = mockCamps.findIndex(c => c._id === id);
            if (campIndex === -1) return res.status(404).json({ message: 'Camp not found.' });
            Object.assign(mockCamps[campIndex], updates);
        }
        res.json({ message: 'Camp updated successfully', camp: { _id: id, ...updates } });
    } catch (e) {
        console.error("Error updating camp in MongoDB/Mock:", e);
        res.status(500).json({ message: 'Server error updating camp.' });
    }
});

/**
 * DELETE Camp (Admin only)
 */
app.delete('/api/camps/:id', authMiddleware, isAdmin, async (req, res) => {
    const id = req.params.id;

    try {
        if (campsCollection) {
            const result = await campsCollection.deleteOne({ _id: new ObjectId(id) });
            if (result.deletedCount === 0) {
                return res.status(404).json({ message: 'Camp not found.' });
            }
        } else {
            const index = mockCamps.findIndex(c => c._id === id);
            if (index === -1) return res.status(404).json({ message: 'Camp not found.' });
            mockCamps.splice(index, 1);
        }
        res.status(200).json({ message: 'Camp deleted successfully' });
    } catch (e) {
        console.error("Error deleting camp from MongoDB/Mock:", e);
        res.status(500).json({ message: 'Server error deleting camp.' });
    }
});

// --- NEW BOOKING ROUTES (Protected) ---

/**
 * POST: User books a slot at a specific camp.
 */
app.post('/api/camps/:id/book', authMiddleware, async (req, res) => {
    const campId = req.params.id;
    const userId = req.user.userId;
    const userName = req.user.name || 'Anonymous User';
    
    const bookingNumber = generateBookingNumber(campId);

    const newBooking = {
        campId,
        userId,
        userName,
        bookingNumber,
        bookedAt: new Date().toISOString(),
        campName: req.body.campName || 'Unknown Camp' 
    };

    try {
        if (bookingsCollection) {
            const existingBooking = await bookingsCollection.findOne({ campId, userId });
            if (existingBooking) {
                return res.status(400).json({ message: 'You have already booked a slot for this camp.', booking: existingBooking });
            }

            const result = await bookingsCollection.insertOne(newBooking);
            newBooking._id = result.insertedId;
        } else {
            const existingBooking = mockBookings.find(b => b.campId === campId && b.userId === userId);
            if (existingBooking) {
                return res.status(400).json({ message: 'You have already booked a slot for this camp.', booking: existingBooking });
            }

            newBooking._id = 'book-mock-' + mockBookings.length + 1;
            mockBookings.push(newBooking);
        }
        
        res.status(201).json({ 
            message: 'Slot booked successfully. Check your bookings dashboard.', 
            booking: newBooking 
        });
    } catch (e) {
        console.error("Error creating booking:", e);
        res.status(500).json({ message: 'Server error creating booking.' });
    }
});

/**
 * GET: User retrieves their own booked slots.
 */
app.get('/api/bookings/my', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    try {
        if (bookingsCollection) {
            const myBookings = await bookingsCollection.find({ userId }).toArray();
            return res.json(myBookings);
        }
        return res.json(mockBookings.filter(b => b.userId === userId));
    } catch (e) {
        console.error("Error fetching user bookings:", e);
        res.status(500).json({ message: 'Server error fetching bookings.' });
    }
});

/**
 * GET: Admin retrieves ALL booked patient slots.
 */
app.get('/api/bookings/admin', authMiddleware, isAdmin, async (req, res) => {
    try {
        if (bookingsCollection) {
            const allBookings = await bookingsCollection.find({}).sort({ bookedAt: -1 }).toArray();
            return res.json(allBookings);
        }
        return res.json(mockBookings);
    } catch (e) {
        console.error("Error fetching all bookings for admin:", e);
        res.status(500).json({ message: 'Server error fetching all bookings.' });
    }
});

// --- NEW FEEDBACK ROUTES ---

/**
 * POST: User submits public feedback (Auth required).
 */
app.post('/api/feedback', authMiddleware, async (req, res) => {
    const { rating, comment } = req.body;
    const { userId, name: userName } = req.user;
    
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
        return res.status(400).json({ message: 'Rating must be a number between 1 and 5.' });
    }
    if (!comment || comment.length < 10) {
        return res.status(400).json({ message: 'Comment must be at least 10 characters long.' });
    }

    const newFeedback = {
        userId,
        userName,
        rating,
        comment,
        submittedAt: new Date().toISOString()
    };

    try {
        if (feedbackCollection) {
            const result = await feedbackCollection.insertOne(newFeedback);
            newFeedback._id = result.insertedId;
        } else {
            newFeedback._id = 'feedback-mock-' + mockFeedback.length + 1;
            mockFeedback.push(newFeedback);
        }
        
        res.status(201).json({ 
            message: 'Feedback submitted successfully. Thank you!', 
            feedback: newFeedback 
        });
    } catch (e) {
        console.error("Error submitting feedback:", e);
        res.status(500).json({ message: 'Server error submitting feedback.' });
    }
});

/**
 * GET: Retrieve all public feedback (Auth required to view).
 */
app.get('/api/feedback', authMiddleware, async (req, res) => {
    try {
        if (feedbackCollection) {
            const allFeedback = await feedbackCollection.find({})
                .sort({ submittedAt: -1 })
                .toArray();
            return res.json(allFeedback);
        }
        return res.json([...mockFeedback].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)));
    } catch (e) {
        console.error("Error fetching feedback:", e);
        res.status(500).json({ message: 'Server error fetching feedback.' });
    }
});


// --- Local Execution vs. Serverless Export ---

// VERCEL REQUIREMENT: Export the app instance for Vercel to use.
module.exports = app;

// LOCAL EXECUTION: Only call app.listen if the script is run directly (not imported by Vercel).
if (require.main === module) {
    // We explicitly call connectToMongo() here only for the local environment
    connectToMongo().then(() => {
        // We'll use express.static here for local testing only.
        app.use(express.static(publicPath));
        
        // Local fallback route to serve the frontend for development
        app.get('/', (req, res) => {
             res.sendFile(path.join(publicPath, 'index.html'));
        });

        app.listen(PORT, () => {
            console.log(`\n--- LOCAL DEVELOPMENT MODE ---`);
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Frontend served from http://localhost:${PORT}/`);
            console.log(`Admin (Plain Text): ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
            console.log(`------------------------------\n`);
        });
    });
}

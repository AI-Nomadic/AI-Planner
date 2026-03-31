"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const generative_ai_1 = require("@google/generative-ai");
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 8081;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// -- Gemini Configuration --
const apiKey = process.env.VITE_GEMINI_API_KEY || '';
const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
const ITINERARY_SCHEMA = {
    description: "Travel itinerary skeleton",
    type: generative_ai_1.SchemaType.OBJECT,
    properties: {
        trip_title: { type: generative_ai_1.SchemaType.STRING },
        total_days: { type: generative_ai_1.SchemaType.NUMBER },
        currency: { type: generative_ai_1.SchemaType.STRING },
        location: {
            type: generative_ai_1.SchemaType.OBJECT,
            properties: {
                province: { type: generative_ai_1.SchemaType.STRING },
                region: { type: generative_ai_1.SchemaType.STRING }
            },
            required: ["province", "region"]
        },
        metrics: {
            type: generative_ai_1.SchemaType.OBJECT,
            properties: {
                budgetRange: { type: generative_ai_1.SchemaType.STRING },
                difficulty: { type: generative_ai_1.SchemaType.STRING },
                activityLevel: { type: generative_ai_1.SchemaType.STRING }
            },
            required: ["budgetRange", "difficulty", "activityLevel"]
        },
        itinerary: {
            type: generative_ai_1.SchemaType.ARRAY,
            items: {
                type: generative_ai_1.SchemaType.OBJECT,
                properties: {
                    theme: { type: generative_ai_1.SchemaType.STRING },
                    accommodation: {
                        type: generative_ai_1.SchemaType.OBJECT,
                        properties: {
                            hotelName: { type: generative_ai_1.SchemaType.STRING },
                            address: { type: generative_ai_1.SchemaType.STRING },
                            description: { type: generative_ai_1.SchemaType.STRING },
                            pricePerNight: { type: generative_ai_1.SchemaType.NUMBER }
                        },
                        required: ["hotelName", "address", "description", "pricePerNight"]
                    },
                    activities: {
                        type: generative_ai_1.SchemaType.ARRAY,
                        minItems: 3,
                        maxItems: 3,
                        items: {
                            type: generative_ai_1.SchemaType.OBJECT,
                            properties: {
                                title: { type: generative_ai_1.SchemaType.STRING },
                                location: { type: generative_ai_1.SchemaType.STRING },
                                description: { type: generative_ai_1.SchemaType.STRING },
                                category: { type: generative_ai_1.SchemaType.STRING },
                                cost_estimate: { type: generative_ai_1.SchemaType.NUMBER },
                                durationMinutes: { type: generative_ai_1.SchemaType.NUMBER }
                            },
                            required: ["title", "location", "description", "category", "cost_estimate", "durationMinutes"]
                        }
                    }
                },
                required: ["theme", "accommodation", "activities"]
            }
        }
    },
    required: ["trip_title", "total_days", "currency", "location", "metrics", "itinerary"]
};
// -- Main Generation Endpoint --
app.post('/api/planner/generate', async (req, res) => {
    const { destination, startDate, endDate, budget, vibe, travelers, interests, numDays, month } = req.body;
    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: ITINERARY_SCHEMA,
        },
        systemInstruction: `You are a professional travel concierge. Your task is to generate a highly detailed travel itinerary.
    Each day MUST include exactly 1 hotel (accommodation) and exactly 3 activities.
    The activities must match the user's interests and budget.
    For coordinates, provide the best estimate, but prioritize accurate names so they can be looked up via Google Maps.`
    });
    const prompt = `Generate a ${numDays}-day ${vibe} trip to ${destination} in Canada for ${travelers} travelers during the month of ${month} (Dates: ${startDate} to ${endDate}).
  The budget tier is ${budget}.
  Interests: ${interests}.
  Provide a detailed skeleton itinerary for each day according to the schema.`;
    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const skeleton = JSON.parse(responseText);
        // Return the skeleton response
        // In the future, this is where we would trigger Phase 2: Enrichment
        res.json(skeleton);
    }
    catch (error) {
        console.error("AI Generation failed:", error);
        res.status(500).json({ error: "Failed to generate plan" });
    }
});
app.listen(port, () => {
    console.log(`AI Planner service listening at http://localhost:${port}`);
});
//# sourceMappingURL=index.js.map
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, SchemaType, Schema } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import { Client as GoogleMapsClient, PlaceInputType } from '@googlemaps/google-maps-services-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 8888;

app.use(cors());
app.use(express.json());

// -- API Clients --
const mapsClient = new GoogleMapsClient({});
const tripSessions = new Map<string, any>();

// -- Gemini Configuration --
const apiKey = process.env.VITE_GEMINI_API_KEY || '';
const mapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

const ITINERARY_SCHEMA: Schema = {
  description: "Travel itinerary skeleton",
  type: SchemaType.OBJECT,
  properties: {
    trip_title: { type: SchemaType.STRING },
    total_days: { type: SchemaType.NUMBER },
    currency: { type: SchemaType.STRING },
    location: {
      type: SchemaType.OBJECT,
      properties: {
        province: { type: SchemaType.STRING },
        region: { type: SchemaType.STRING }
      },
      required: ["province", "region"]
    },
    taxonomy: {
      type: SchemaType.OBJECT,
      properties: {
        theme: { type: SchemaType.STRING },
        themeLabel: { type: SchemaType.STRING },
        travelType: { type: SchemaType.STRING },
        travelTypeLabel: { type: SchemaType.STRING }
      },
      required: ["theme", "themeLabel", "travelType", "travelTypeLabel"]
    },
    metrics: {
      type: SchemaType.OBJECT,
      properties: {
        budgetRange: { type: SchemaType.STRING },
        difficulty: { type: SchemaType.STRING },
        activityLevel: { type: SchemaType.STRING }
      },
      required: ["budgetRange", "difficulty", "activityLevel"]
    },
    tags: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING }
    },
    summaryStats: {
        type: SchemaType.OBJECT,
        properties: {
            totalActivities: { type: SchemaType.NUMBER },
            avgCostPerDay: { type: SchemaType.NUMBER }
        },
        required: ["totalActivities", "avgCostPerDay"]
    },
    itinerary: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          theme: { type: SchemaType.STRING },
          accommodation: {
            type: SchemaType.OBJECT,
            properties: {
              hotelName: { type: SchemaType.STRING },
              address: { type: SchemaType.STRING },
              description: { type: SchemaType.STRING },
              pricePerNight: { type: SchemaType.NUMBER }
            },
            required: ["hotelName", "address", "description", "pricePerNight"]
          },
          activities: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                title: { type: SchemaType.STRING },
                location: { type: SchemaType.STRING },
                description: { type: SchemaType.STRING },
                category: { type: SchemaType.STRING },
                cost_estimate: { type: SchemaType.NUMBER },
                durationMinutes: { type: SchemaType.NUMBER }
              },
              required: ["title", "location", "description", "category", "cost_estimate", "durationMinutes"]
            }
          }
        },
        required: ["theme", "accommodation", "activities"]
      }
    }
  },
  required: [
    "trip_title", "total_days", "currency", "location", "taxonomy", 
    "metrics", "tags", "summaryStats", "itinerary"
  ]
};

// --- LOGISTICS & TIMELINE HELPERS ---

const addMinutes = (timeStr: string, mins: number): string => {
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  
  const date = new Date(0, 0, 0, hours, minutes + mins);
  let h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, '0');
  const p = h >= 12 ? 'PM' : 'AM';
  
  h = h % 12;
  h = h ? h : 12;
  
  return `${h}:${m} ${p}`;
};

const calculateDistance = (p1: any, p2: any): number => {
  if (!p1 || !p2) return 5; // Default 5km if missing
  const R = 6371; // Radius of earth in km
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(p1.lat * Math.PI/180) * Math.cos(p2.lat * Math.PI/180) * 
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const estimateTravelTime = (distanceKm: number): number => {
  const avgSpeed = 30; // 30 km/h avg including traffic
  const buffer = 5; // 5 min transition buffer
  const timeMins = (distanceKm / avgSpeed) * 60;
  return Math.ceil(timeMins + buffer);
};

// --- HYDRATORS ---

const searchPhotos = async (query: string, count: number): Promise<string[]> => {
  const sig = Math.floor(Math.random() * 1000000);
  return Array.from({ length: count }, (_, i) => 
    `https://images.unsplash.com/photo-${1500000000000 + (sig % 50000)}?q=80&w=800&auto=format&fit=crop&sig=${i}_${encodeURIComponent(query)}`
  );
};

const searchPlaceDetails = async (query: string) => {
  if (mapsApiKey) {
    try {
        const searchResponse = await mapsClient.findPlaceFromText({
            params: {
                input: query,
                inputtype: PlaceInputType.textQuery,
                fields: ['geometry', 'place_id', 'formatted_address', 'rating', 'user_ratings_total'],
                key: mapsApiKey,
            }
        });

        const basicPlace = searchResponse.data.candidates?.[0];
        if (basicPlace && basicPlace.place_id) {
            const detailsResponse = await mapsClient.placeDetails({
                params: {
                    place_id: basicPlace.place_id,
                    fields: ['formatted_phone_number', 'website', 'opening_hours'],
                    key: mapsApiKey,
                }
            });
            const richPlace = detailsResponse.data.result;
            return {
                lat: basicPlace.geometry?.location.lat,
                lng: basicPlace.geometry?.location.lng,
                placeId: basicPlace.place_id,
                rating: basicPlace.rating,
                user_ratings_total: basicPlace.user_ratings_total,
                contactNumber: richPlace?.formatted_phone_number,
                website: richPlace?.website,
                openingHours: richPlace?.opening_hours?.weekday_text,
                mapLink: `https://www.google.com/maps/place/?q=place_id:${basicPlace.place_id}`
            };
        }
    } catch (e) {
        console.error("[GoogleMaps] Error:", e);
    }
  }

  // Fallback Mock
  return {
    lat: 49.2827 + (Math.random() - 0.5) * 0.05,
    lng: -123.1207 + (Math.random() - 0.5) * 0.05,
    placeId: "mock_" + uuidv4().slice(0, 8),
    rating: (Math.random() * 1.5 + 3.5).toFixed(1),
    user_ratings_total: Math.floor(Math.random() * 5000),
    contactNumber: "+1 (604) 555-0199",
    website: "https://example.com/verified",
    openingHours: ["Mon-Fri: 9-5"],
    mapLink: "#"
  };
};

// --- ROUTES ---

app.post('/api/planner/generate', async (req, res) => {
  const { destination, travelers, vibe, budget, interests, numDays, month, startDate, endDate } = req.body;
  const model = genAI.getGenerativeModel({
    model: "gemini-flash-latest",
    generationConfig: { responseMimeType: "application/json", responseSchema: ITINERARY_SCHEMA },
    systemInstruction: `You are a professional travel concierge. 
    Create a highly accurate Canadian travel itinerary. 
    1 hotel per day (can be same or different), 3 activities per day. 
    ACCURACY RULES:
    1. Taxonomy: Choose internal 'theme' tags like 'nature', 'luxury', 'urban', 'foodie' and user-friendly 'themeLabel'.
    2. Metrics: Calculate 'budgetRange' based on real hotel prices ($ < $200, $$ < $400, $$$ < $700, $$$$ > $700).
    3. Metrics: Set 'difficulty' and 'activityLevel' based on the physical intensity of activities.
    4. Tags: Extract 4-6 specific tags like 'mountains', 'spa', 'museums' from the content.
    5. Summary: Ensure totalActivities and avgCostPerDay match your generated numbers.`
  });

  try {
    const userPrompt = `Generate a trip to ${destination} for ${numDays} days. 
    Timeframe: ${month || 'Anytime'}. 
    Vibe: ${vibe}. 
    Budget Level: ${budget}. 
    Interests: ${interests}. 
    Ensure the geography is consistent for ${destination}.`;
    
    const result = await model.generateContent(userPrompt);
    const skeleton = JSON.parse(result.response.text());
    const tripId = uuidv4();
    skeleton.id = tripId;

    skeleton.itinerary = skeleton.itinerary.map((day: any, idx: number) => {
        day.id = uuidv4();
        day.tripId = tripId;
        day.dayNumber = idx + 1;
        day.accommodation.id = uuidv4();
        day.activities = day.activities.map((act: any) => ({ ...act, id: uuidv4(), status: "planned" }));
        return day;
    });

    tripSessions.set(tripId, skeleton);
    res.json(skeleton);
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get('/api/planner/stream/:tripId', async (req, res) => {
  const { tripId } = req.params;
  const trip = tripSessions.get(tripId);
  if (!trip) return res.status(404).end();

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  for (let i = 0; i < trip.itinerary.length; i++) {
    const day = trip.itinerary[i];
    let currentTime = "9:00 AM";

    // 1. Hydrate Accommodation Details
    const hotelDetails = await searchPlaceDetails(day.accommodation.hotelName + " " + destinationLabel(trip));
    day.accommodation = { ...day.accommodation, ...hotelDetails };
    day.accommodation.imageGallery = await searchPhotos(day.accommodation.hotelName, 4);

    // 2. Hydrate Activities & Calculate Timeline
    let lastCoords = { lat: hotelDetails.lat, lng: hotelDetails.lng };

    for (const act of day.activities) {
        const details = await searchPlaceDetails(act.title + " " + act.location + " " + destinationLabel(trip));
        act.imageGallery = await searchPhotos(act.title, 3);
        
        // --- LOGISTICS ENGINE ---
        const dist = calculateDistance(lastCoords, { lat: details.lat, lng: details.lng });
        const travelMins = estimateTravelTime(dist);
        
        act.travelTimeFromPrev = travelMins;
        act.timeSlot = {
            start: addMinutes(currentTime, travelMins),
            end: addMinutes(addMinutes(currentTime, travelMins), act.durationMinutes || 120)
        };
        act.time = act.timeSlot.start;
        act.coordinates = { lat: details.lat, lng: details.lng };
        act.placeId = details.placeId;
        act.rating = details.rating;
        act.user_ratings_total = details.user_ratings_total;
        act.contactNumber = details.contactNumber;
        act.website = details.website;
        act.openingHours = details.openingHours;

        // Move the "Clock" forward
        currentTime = act.timeSlot.end;
        lastCoords = { lat: details.lat, lng: details.lng };
    }

    res.write(`event: day_hydrated\ndata: ${JSON.stringify({ dayIndex: i, dayData: day })}\n\n`);
    await new Promise(r => setTimeout(r, 600));
  }

  res.write(`event: complete\ndata: ${JSON.stringify({ message: "Done" })}\n\n`);
  res.end();
  setTimeout(() => tripSessions.delete(tripId), 5 * 60 * 1000);
});

function destinationLabel(trip: any) {
    return `${trip.location.region || ''} ${trip.location.province || ''}`;
}

app.listen(port, () => {
  console.log(`Planner streaming on http://localhost:${port}`);
});

// Stay-alive for experimental Node.js
setInterval(() => {}, 1000 * 60 * 60);

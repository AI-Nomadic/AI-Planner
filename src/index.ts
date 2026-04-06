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
const ticketmasterKey = process.env.TICKETMASTER_API_KEY || '';

const genAI = new GoogleGenerativeAI(apiKey);
console.log(`[Gemini] Key Status: ${apiKey ? apiKey.slice(0, 4) + '...' : 'MISSING'}`);
console.log(`[Ticketmaster] Key Status: ${ticketmasterKey ? 'LOADED' : 'MISSING'}`);

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

const SUGGESTIONS_SCHEMA: Schema = {
  description: "List of activity suggestions",
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },             // Full proper venue/attraction name
      category: { type: SchemaType.STRING },          // e.g. Sightseeing, Food, Adventure
      short_reason: { type: SchemaType.STRING },      // 1 sentence why it's recommended
      location: { type: SchemaType.STRING },          // Specific street address or area
      description: { type: SchemaType.STRING },       // 2-3 sentence engaging description
      cost_estimate: { type: SchemaType.NUMBER },     // Realistic per-person cost in CAD
      durationMinutes: { type: SchemaType.NUMBER },   // Realistic visit duration in minutes
    },
    required: ["title", "category", "short_reason", "location", "description", "cost_estimate", "durationMinutes"]
  }
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
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
          fields: ['geometry', 'place_id', 'formatted_address', 'rating', 'user_ratings_total', 'price_level'],
          key: mapsApiKey,
        }
      });

      const basicPlace = searchResponse.data.candidates?.[0];
      if (basicPlace && basicPlace.place_id) {
        const detailsResponse = await mapsClient.placeDetails({
          params: {
            place_id: basicPlace.place_id,
            fields: ['formatted_phone_number', 'website', 'opening_hours'],  // photos excluded — billed separately
            key: mapsApiKey,
          }
        });
        const richPlace = detailsResponse.data.result;

        // Map price_level (0-4) to rough CAD cost estimate per person
        const priceLevelCost: Record<number, number> = { 0: 0, 1: 15, 2: 35, 3: 70, 4: 150 };
        const costHint = basicPlace.price_level !== undefined ? priceLevelCost[basicPlace.price_level as number] : undefined;

        return {
          coordinates: {
            lat: basicPlace.geometry?.location.lat,
            lng: basicPlace.geometry?.location.lng,
          },
          location: basicPlace.formatted_address || query,
          placeId: basicPlace.place_id,
          rating: basicPlace.rating,
          user_ratings_total: basicPlace.user_ratings_total,
          contactNumber: richPlace?.formatted_phone_number,
          website: richPlace?.website,
          openingHours: richPlace?.opening_hours?.weekday_text,
          mapLink: `https://www.google.com/maps/place/?q=place_id:${basicPlace.place_id}`,
          costHint,
        };
      }
    } catch (e) {
      console.error("[GoogleMaps] Error:", e);
    }
  }

  // Fallback Mock (no Maps API key)
  return {
    coordinates: {
      lat: 49.2827 + (Math.random() - 0.5) * 0.05,
      lng: -123.1207 + (Math.random() - 0.5) * 0.05,
    },
    location: query,
    placeId: "mock_" + uuidv4().slice(0, 8),
    rating: (Math.random() * 1.5 + 3.5).toFixed(1),
    user_ratings_total: Math.floor(Math.random() * 5000),
    contactNumber: "+1 (604) 555-0199",
    website: "https://example.com/verified",
    openingHours: ["Mon-Fri: 9-5"],
    mapLink: "#",
    costHint: undefined
  };
};

// --- TIMEZONE & VIBE HELPERS ---

const fetchTicketmasterEvents = async (params: { lat: number, lng: number, start: string, end: string, categories?: string, limit?: number }) => {
  if (!ticketmasterKey) {
    console.warn("[Ticketmaster] Missing API Key. Skipping event fetch.");
    return [];
  }

  const { lat, lng, start, end, categories, limit = 10 } = params;
  
  const searchParams = new URLSearchParams({
    latlong: `${lat},${lng}`,
    radius: '10',
    unit: 'km',
    startDateTime: `${start}T00:00:00Z`,
    endDateTime: `${end}T23:59:59Z`,
    sort: 'distance,asc',
    size: String(limit),
    apikey: ticketmasterKey
  });

  if (categories) {
    // If it starts with Ticketmaster segment prefix, use segmentId parameter
    if (categories.startsWith('KZFz')) {
      searchParams.append('segmentId', categories);
    } else {
      searchParams.append('classificationName', categories);
    }
  }

  const url = `https://app.ticketmaster.com/discovery/v2/events.json?${searchParams.toString()}`;
  console.log(`📡 [Ticketmaster] Calling: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("[Ticketmaster] API Error:", await response.text());
      return [];
    }

    const data = await response.json() as any;
    const events = data._embedded?.events || [];

    return events.map((ev: any) => {
      // Find the best quality 16:9 image
      const bestImage = ev.images
        ?.filter((img: any) => img.ratio === '16_9')
        ?.sort((a: any, b: any) => b.width - a.width)[0]?.url || ev.images?.[0]?.url;

      const price = ev.priceRanges?.[0]?.min;

      // Format time to 7:00 PM style if localTime exists
      let displayTime = ev.dates.start.localTime || '19:00:00';
      try {
        const [h, m] = displayTime.split(':');
        const hh = parseInt(h);
        displayTime = `${hh % 12 || 12}:${m} ${hh >= 12 ? 'PM' : 'AM'}`;
      } catch (e) {
        console.warn("[Ticketmaster] Time format failed:", e);
      }

      return {
        id: ev.id,
        title: ev.name,
        category: ev.classifications?.[0]?.segment?.name || 'Event',
        short_reason: `Featuring ${ev.name} at ${ev._embedded?.venues?.[0]?.name || 'Local Venue'}.`,
        location: `${ev._embedded?.venues?.[0]?.address?.line1 || ''}, ${ev._embedded?.venues?.[0]?.city?.name || ''}`,
        description: ev.info || ev.pleaseNote || `Attend this ${ev.classifications?.[0]?.segment?.name || 'special'} event in Canada.`,
        cost_estimate: price !== undefined ? price : 0, // Fallback to 0 if missing
        price_note: price === undefined ? "Check website for price" : undefined,
        durationMinutes: 120,
        time: displayTime,
        start_date: `${ev.dates.start.localDate}T${ev.dates.start.localTime || '19:00:00'}`,
        eventDate: ev.dates.start.localDate,
        bookingUrl: ev.url,
        imageUrl: bestImage,
        isSkeleton: true,
        isEvent: true
      };
    });
  } catch (e) {
    console.error("[Ticketmaster] Fetch failed:", e);
    return [];
  }
};


// --- ROUTES ---

app.post('/api/planner/generate', async (req, res) => {
  const { destination, travelers, vibe, budget, interests, numDays, month, startDate, endDate } = req.body;
  console.log(`🚀 [Planner] Generating Trip for: ${destination} (${numDays} days)`);

  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",  // Quality-critical, called once per trip — 20 RPD is fine
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
    console.log("📡 [Planner] Sending request to Gemini...");
    
    // PHASE A: Fetch top Ticketmaster events to inspire the AI
    let eventsPrompt = "";
    try {
        const details = await searchPlaceDetails(destination);
        if (details.coordinates && ticketmasterKey) {
            const start = startDate || new Date().toISOString().split('T')[0];
            const end = endDate || new Date(Date.now() + numDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            
            const events = await fetchTicketmasterEvents({
                lat: details.coordinates.lat || 0,
                lng: details.coordinates.lng || 0,
                start,
                end,
                limit: 5
            });
            
            if (events.length > 0) {
                eventsPrompt = `\nREAL-WORLD EVENTS from Ticketmaster occurring during this trip:\n` + 
                    events.map((e: any) => `- ${e.title} (${e.category}): ${e.description} at ${e.location}`).join('\n') +
                    `\nINSTRUCTION: Try to include at least one of these real-world events in the itinerary if they fit the vibe and timing.`;
            }
        }
    } catch (e) {
        console.warn("[Phase A] Failed to fetch events for prompt enhancement:", e);
    }

    const userPrompt = `Generate a trip to ${destination} for ${numDays} days. 
    Timeframe: ${month || 'Anytime'}. 
    Vibe: ${vibe}. 
    Budget Level: ${budget}. 
    Interests: ${interests}. 
    Ensure the geography is consistent for ${destination}.${eventsPrompt}`;

    const result = await model.generateContent(userPrompt);
    console.log("📥 [Planner] Gemini Response Received");
    const rawResponse = result.response.text();
    console.log("📝 [Planner] Raw Response:", rawResponse.substring(0, 100) + "...");
    const skeleton = JSON.parse(rawResponse);
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
  } catch (error: any) {
    console.error("❌ [Planner] Generation Error:", error);
    if (error.response) console.error("Gemini Error Data:", error.response);
    res.status(500).json({
      error: "Failed to generate",
      detail: error.message || "Unknown error",
      keyStatus: apiKey ? 'Loaded' : 'Missing'
    });
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
    let lastCoords = hotelDetails.coordinates;

    for (const act of day.activities) {
      const details = await searchPlaceDetails(act.title + " " + act.location + " " + destinationLabel(trip));
      act.imageGallery = await searchPhotos(act.title, 3);

      // --- LOGISTICS ENGINE ---
      const dist = calculateDistance(lastCoords, details.coordinates);
      const travelMins = estimateTravelTime(dist);

      act.travelDistance = Math.round(dist * 10) / 10; // New field for Java Backend
      act.travelTimeFromPrev = travelMins;
      act.timeSlot = {
        start: addMinutes(currentTime, travelMins),
        end: addMinutes(addMinutes(currentTime, travelMins), act.durationMinutes || 120)
      };
      act.time = act.timeSlot.start;
      act.coordinates = details.coordinates;
      act.placeId = details.placeId;
      act.rating = details.rating;
      act.user_ratings_total = details.user_ratings_total;
      act.contactNumber = details.contactNumber;
      act.website = details.website;
      act.openingHours = details.openingHours;

      // Move the "Clock" forward
      currentTime = act.timeSlot.end;
      lastCoords = details.coordinates;
    }

    res.write(`event: day_hydrated\ndata: ${JSON.stringify({ dayIndex: i, dayData: day })}\n\n`);
    await new Promise(r => setTimeout(r, 600));
  }

  res.write(`event: complete\ndata: ${JSON.stringify({ message: "Done" })}\n\n`);
  res.end();
  setTimeout(() => tripSessions.delete(tripId), 5 * 60 * 1000);
});

// --- TRAVEL DATA ARCHITECT (Post-Review Logic) ---
app.post('/api/planner/audit', async (req, res) => {
  const trip: any = req.body;
  if (!trip) return res.status(400).json({ error: "Missing Trip data" });

  console.log(`🔍 [Architect] Auditing Trip: ${trip.trip_title} (${trip.id})`);

  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });  // Quality reasoning for audit — called once on save

  // 1. Logic for Vibe & Budget Audit (Gemini for speed/smarts)
  const auditPrompt = `
    Perform a Data Architect Audit on this travel itinerary.
    
    TRIP DATA:
    - Title: ${trip.trip_title}
    - Location: ${trip.location.region}, ${trip.location.province}
    - Prompt Vibe: ${trip.taxonomy.themeLabel}
    - Prompt Budget: ${trip.metrics.budgetRange}
    - Start Activity Count: ${trip.summaryStats.totalActivities}
    
    ITINERARY SUMMARY:
    ${trip.itinerary.map((d: any) =>
    `Day ${d.dayNumber}: Hotel: ${d.accommodation?.hotelName}, Activities: ${d.activities.map((a: any) => `${a.title} ($${a.cost_estimate})`).join(', ')}`
  ).join('\n')}

    TASK:
    1. Geo-Normalization: If title/location implies a specific Ontario/Quebec/BC landmark, ensure the province is strictly accurate. 
    2. Dynamic Vibe Analysis: Analyze the nature of activities. If they added Bars/Pubs -> add 'Nightlife'. If Museums/Arts -> add 'Culture'. If Outdoors/Trails -> add 'Nature'. Return a refined string for tags.
    3. Financial Audit: If they selected Budget ($) but have $100+ activities or expensive hotels, re-categorize to $$$ (Luxury) or $$ (Standard).

    OUTPUT JSON:
    Return only a JSON object with these fields:
    {
      "refinedProvince": "Province Name",
      "refinedRegion": "City/Region Name",
      "refinedTags": ["tag1", "tag2"],
      "refinedBudgetRange": "$" | "$$" | "$$$" | "$$$$",
      "refinedThemeLabel": "New Vibe Name",
      "refinedSeason": ["Season1", "Season2"],
      "totalActualCost": number
    }
    `;

  try {
    const result = await model.generateContent(auditPrompt);
    const responseText = result.response.text().replace(/```json|```/g, "").trim();
    const audit = JSON.parse(responseText);

    // Update Trip Object
    trip.location.province = audit.refinedProvince || trip.location.province;
    trip.location.region = audit.refinedRegion || trip.location.region;
    trip.location.slug = (audit.refinedRegion || trip.location.region).toLowerCase().replace(/\s+/g, '-');

    // Merge & Unique Tags
    const existingTags = new Set(trip.tags || []);
    if (audit.refinedTags) {
      audit.refinedTags.forEach((t: string) => existingTags.add(t.toLowerCase()));
    }
    trip.tags = Array.from(existingTags);

    // Update Metrics & Taxonomy
    trip.metrics.budgetRange = audit.refinedBudgetRange || trip.metrics.budgetRange;
    trip.taxonomy.themeLabel = audit.refinedThemeLabel || trip.taxonomy.themeLabel;
    trip.taxonomy.season = audit.refinedSeason || trip.taxonomy.season || [];

    // Update Stats
    const totalActivities = trip.itinerary.reduce((sum: number, d: any) => sum + (d.activities?.length || 0), 0);
    trip.summaryStats.totalActivities = totalActivities;
    if (audit.totalActualCost && trip.total_days > 0) {
      trip.summaryStats.avgCostPerDay = Math.round(audit.totalActualCost / trip.total_days);
    }

    console.log(`✅ [Architect] Audit Complete. New Budget: ${audit.refinedBudgetRange || 'Unchanged'}`);
    res.json(trip);
  } catch (error) {
    console.warn(`⚠️ [Architect] Audit Fallback triggered: Using original trip data.`);
    console.error("Audit Error Detail:", error);
    // CRITICAL: Return original trip so front-end can still persist it despite quota/service errors
    res.json(req.body);
  }
});

// --- SMART SUGGESTIONS ---
app.post('/api/planner/suggestions', async (req, res) => {
  const { destination, tags, type = 'exploration', count = 6, excludeNames = [] } = req.body;
  console.log(`💡 [Planner] Generating ${count} ${type} Suggestions for: ${destination}. Excluding ${excludeNames.length} items.`);

  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-lite-preview",  // 500 RPD / 15 RPM — best quota for frequent sidebar calls
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SUGGESTIONS_SCHEMA
    }
  });

  try {
    let prompt = '';
    
    if (type === 'stay') {
      prompt = `Suggest ${count} highly-rated accommodations, hotels, resorts, or boutique lodges in ${destination} focusing on interests like ${tags?.join(', ') || 'comfortable and central'}.`;
    } else if (type === 'culinary') {
      prompt = `Suggest ${count} unique dining experiences, restaurants, cafes, or bars in ${destination} focusing on interests like ${tags?.join(', ') || 'local favorites'}.`;
    } else {
      prompt = `Suggest ${count} unique activities in ${destination} focusing on interests like ${tags?.join(', ') || 'local culture'}.`;
    }

    if (excludeNames && excludeNames.length > 0) {
      prompt += `\nCRITICAL DO NOT SUGGEST ANY OF THESE as they are already planned: ${excludeNames.join(', ')}.`;
    }
    
    prompt += `\nFor each item return ALL of these fields:
    - title: The full proper name of the specific venue, attraction, or hotel
    - category: ${type === 'stay' ? 'One of: Luxury, Boutique, Resort, Hostel, B&B' : (type === 'culinary' ? 'One of: Breakfast, Lunch, Dinner, Cafe, Bar, Dessert' : 'One of: Food, Sightseeing, Adventure, Relaxation, Nightlife, Lodging')}
    - short_reason: One sentence explaining why it's worth visiting or staying at
    - location: Specific street address or neighbourhood (e.g. "290 Bremner Blvd, ${destination}")
    - description: 2-3 sentence engaging description of what makes it special
    - cost_estimate: Realistic per-person cost in CAD as a number (0 if free) (For stay, use estimated price per night)
    - durationMinutes: Realistic visit duration in minutes as a number (For stay, use 1440)
    Return ONLY a valid JSON array, no markdown.`;

    console.log("📡 [Planner] Calling Gemini for schema-constrained suggestions...");
    const result = await model.generateContent(prompt);

    // Schema-enforced response is always valid JSON — no regex strip needed
    const text = result.response.text();
    const response = JSON.parse(text);

    if (!Array.isArray(response)) {
      throw new Error("AI did not return a JSON array.");
    }

    // Explicitly filter out any hallucinated duplicates that Gemini ignored negative constraints on
    const safeResponse = response.filter((s: any) => {
        if (!excludeNames || excludeNames.length === 0) return true;
        return !excludeNames.some((ex: string) => s.title.toLowerCase().includes(ex.toLowerCase()));
    });

    // Add temporary IDs and Skeleton flag for UI rendering
    let suggestions = safeResponse.map((s: any) => ({
      ...s,
      id: uuidv4(),
      isSkeleton: true
    }));

    if (type === 'stay') {
      console.log(`💧 [Planner] Eagerly hydrating ${suggestions.length} stay suggestions...`);
      suggestions = await Promise.all(
          suggestions.map((suggestion: any) => hydrateAccommodationData(suggestion, destination))
      );
    }

    console.log(`✅ [Planner] Successfully generated ${suggestions.length} suggestions for ${destination}`);
    res.json(suggestions);
  } catch (error: any) {
    console.error("❌ [Planner] Suggestions Error Details:", {
      message: error.message,
      stack: error.stack,
      dest: destination,
      tags: tags
    });
    res.status(500).json({ error: "Failed to fetch suggestions", details: error.message });
  }
});


app.post('/api/planner/hydrate-activity', async (req, res) => {
  const { activity, destination, prevCoords, startTime } = req.body;
  const startAt = startTime || "9:00 AM";

  console.log(`💧 [Planner] Hydrating: "${activity.title}" in ${destination} (skeleton has pre-generated content)`);

  try {
    // Content fields already generated in Phase 1 — no Gemini call needed
    const title = activity.title;
    const location = activity.location || destination;
    const description = activity.description || '';
    const cost_estimate = typeof activity.cost_estimate === 'number' ? activity.cost_estimate : 0;
    const durationMinutes = typeof activity.durationMinutes === 'number' ? activity.durationMinutes : 90;

    // --- STEP 1: Google Places — real-world enrichment only ---
    // Precise query using pre-generated location string (same as stream/:tripId)
    const details = await searchPlaceDetails(`${title} ${location} ${destination}`);
    const photos = await searchPhotos(title, 3);

    // --- STEP 2: Logistics Engine (same as stream/:tripId) ---
    const dist = calculateDistance(prevCoords, details.coordinates);
    const travelMins = estimateTravelTime(dist);

    const timeSlot = {
      start: addMinutes(startAt, travelMins),
      end: addMinutes(addMinutes(startAt, travelMins), durationMinutes)
    };

    const hydratedActivity = {
      ...activity,
      id: activity.id,
      title,
      location: details.location || location,   // prefer Places formatted_address
      description,
      cost_estimate,
      durationMinutes,
      coordinates: details.coordinates,
      placeId: details.placeId,
      rating: details.rating,
      user_ratings_total: details.user_ratings_total,
      contactNumber: details.contactNumber,
      website: details.website,
      openingHours: details.openingHours,
      mapLink: details.mapLink,
      imageGallery: photos,
      imageUrl: photos[0],
      travelDistance: Math.round(dist * 10) / 10,
      travelTimeFromPrev: travelMins,
      timeSlot,
      time: timeSlot.start,
      status: 'planned',
      type: 'activity',
      isSkeleton: false,
      isHydrating: false,
      metadata: { isLocked: false, source: 'ai_generated' }
    };

    console.log(`✅ [Planner] Hydration Complete: "${title}" — Start: ${timeSlot.start}, Travel: ${travelMins}min`);
    res.json(hydratedActivity);
  } catch (error: any) {
    console.error("❌ [Planner] Hydration Error:", error);
    res.status(500).json({ error: "Failed to hydrate activity", details: error.message });
  }
});



const hydrateAccommodationData = async (accommodation: any, destination: string) => {
  const title = accommodation.title || accommodation.hotelName;
  const location = accommodation.location || destination;
  const description = accommodation.description || '';
  const cost_estimate = typeof accommodation.cost_estimate === 'number' ? accommodation.cost_estimate : 200;

  const details = await searchPlaceDetails(`${title} ${location} ${destination} hotel`);
  const photos = await searchPhotos(title + " hotel", 3);

  return {
    ...accommodation,
    id: accommodation.id,
    type: 'hotel',
    hotelName: title,
    address: details.location || location,
    description: description,
    pricePerNight: cost_estimate,
    rating: details.rating ? Number(details.rating) : 4.0,
    contactNumber: details.contactNumber || '',
    mapLink: details.mapLink || '',
    bookingUrl: details.website || '',
    imageGallery: photos,
    amenities: ['Wifi', 'Air Conditioning', 'Breakfast'],
    coordinates: details.coordinates,
    isSkeleton: false,
    isHydrating: false,
    bookingStatus: 'draft'
  };
};

app.post('/api/planner/hydrate-accommodation', async (req, res) => {
  const { accommodation, destination } = req.body;
  console.log(`💧 [Planner] Hydrating Accommodation: "${accommodation.title || accommodation.hotelName}" in ${destination}`);

  try {
    const hydratedAccommodation = await hydrateAccommodationData(accommodation, destination);
    console.log(`✅ [Planner] Hydration Complete for Accommodation: "${hydratedAccommodation.hotelName}"`);
    res.json(hydratedAccommodation);
  } catch (error: any) {
    console.error("❌ [Planner] Accommodation Hydration Error:", error);
    res.status(500).json({ error: "Failed to hydrate accommodation", details: error.message });
  }
});

app.post('/api/planner/events', async (req, res) => {
  const { destination, categories, startDate, endDate, tags } = req.body;
  console.log(`🎟️ [Planner] Fetching Dynamic Ticketmaster Events for: ${destination}`);

  try {
    // 1. Get Coordinates for destination
    const details = await searchPlaceDetails(destination);
    if (!details.coordinates) throw new Error("Could not find coordinates for destination");

    // 2. Map Sidebar Tags to Ticketmaster Segment IDs
    let classificationFilter = categories;
    if (!classificationFilter && tags && tags.length > 0) {
        const tag = tags[0];
        // Use hard IDs for reliability as requested
        if (tag === 'Music') classificationFilter = 'KZFzniwnSyZfZ7v7nJ';
        else if (tag === 'Sports') classificationFilter = 'KZFzniwnSyZfZ7v7nE';
        else if (tag === 'Arts & Theatre') classificationFilter = 'KZFzniwnSyZfZ7v7na';
        else if (tag === 'Film') classificationFilter = 'KZFzniwnSyZfZ7v7nn';
        else if (tag === 'Miscellaneous') classificationFilter = 'KZFzniwnSyZfZ7v7n1';
        else classificationFilter = tag; 
    }

    const start = startDate || new Date().toISOString().split('T')[0];
    const end = endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const events = await fetchTicketmasterEvents({
        lat: details.coordinates.lat || 0,
        lng: details.coordinates.lng || 0,
        start,
        end,
        categories: classificationFilter,
        limit: 12
    });

    console.log(`✅ [Ticketmaster] Found ${events.length} events for ${destination}`);
    res.json(events);
  } catch (error: any) {
    console.error("❌ [Ticketmaster] Error:", error.message);
    res.status(500).json({ error: "Failed to fetch Ticketmaster events", details: error.message });
  }
});

function destinationLabel(trip: any) {
  return `${trip.location.region || ''} ${trip.location.province || ''}`;
}

app.listen(port, () => {
  console.log(`Planner streaming on http://localhost:${port}`);
});

// Stay-alive for experimental Node.js
setInterval(() => { }, 1000 * 60 * 60);

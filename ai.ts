import { GenerateContentConfig, GoogleGenAI, Type, createPartFromUri, createUserContent } from "@google/genai";

export async function generateImageAnalysis(fileUri: string) {
  const ai = new GoogleGenAI({
    vertexai: false,
    apiKey: Deno.env.get("GEMINI_API_KEY"),
    googleAuthOptions: {
      // scopes: ["https://www.googleapis.com/auth/devstorage.read_only", "https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/generative-language"],
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only", "https://www.googleapis.com/auth/cloud-platform"],
      keyFile: "temp/crafty-router-207406-8e0141ef7960.json",
      // projectId: "crafty-router-207406"
    },
  });

  const config: GenerateContentConfig = {
    thinkingConfig: {
      thinkingBudget: 0,
    },
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      required: ["title", "description", "positions"],
      properties: {
        title: {
          type: Type.STRING,
        },
        description: {
          type: Type.STRING,
        },
        positions: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
          },
        },
      },
    },
  };
  const model = "gemini-flash-lite-latest";
  const contents = createUserContent([
    `Analyze the image and output a JSON object with three keys:
1. title: A 2-7 word title.
2. description: A short paragraph description.
3. positions: A list of strings stating the name and describing the location of the primary focal point(s) only.

Rules for 'positions':
- The 'Main Character' Rule: If a person or animal is present, they are the primary subject. Do not list their clothing, accessories (like backpacks, hats, or held items), or the background environment (like fields, walls, or furniture) as separate entries. Treat accessories as part of the subject.
- The 'Still Life' Rule: If no people or animals are present, list the position of the most prominent object (e.g., a vase of flowers, a car, a mountain)`,
    createPartFromUri(fileUri, "image/jpeg"),
  ]);

  const response = await ai.models.generateContent({
    model,
    config,
    contents,
  });

  return response;
}

if (import.meta.main) {
  const gcsUri = Deno.args[0];
  if (!gcsUri) {
    console.error("Usage: deno run --allow-env --allow-net ai.ts <gcs-image-uri>");
    Deno.exit(1);
  }

  try {
    const analysis = await generateImageAnalysis(gcsUri);
    console.log("Image Analysis Result:");
    console.log(JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error("Error generating image analysis:", error);
    // Deno.exit(1);
  }
}


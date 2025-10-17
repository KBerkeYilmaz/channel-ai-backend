import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env';

// Use environment variable or fallback to your connection string
const uri = env.DATABASE_URL;
if (!uri) {
  throw new Error('DATABASE_URL environment variable is required');
}

const options = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
};

let client: MongoClient;
let clientPromise: Promise<MongoClient>;

if (env.NODE_ENV === 'development') {
  // In development mode, use a global variable so that the value
  // is preserved across module reloads caused by HMR (Hot Module Replacement).
  const globalWithMongo = global as typeof globalThis & {
    _mongoClientPromise?: Promise<MongoClient>;
  };

  if (!globalWithMongo._mongoClientPromise) {
    client = new MongoClient(uri, options);
    globalWithMongo._mongoClientPromise = client.connect();
  }
  clientPromise = globalWithMongo._mongoClientPromise;
} else {
  // In production mode, it's best to not use a global variable.
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

export async function connectToDatabase(): Promise<{ client: MongoClient; db: Db }> {
  const client = await clientPromise;
  const db = client.db('channel_ai');

  // OPTIMIZATION: Ensure indexes exist for performance
  await ensureIndexes(db);

  return { client, db };
}

// Ensure critical indexes exist for optimal query performance
async function ensureIndexes(db: Db) {
  try {
    const transcriptChunks = db.collection('transcript_chunks');

    // Index for fast lookup by creatorId and text (used in video references)
    await transcriptChunks.createIndex(
      { creatorId: 1, text: 1 },
      { background: true, name: 'creatorId_text_idx' }
    );

    // Index for fast lookup by creatorId and videoId
    await transcriptChunks.createIndex(
      { creatorId: 1, videoId: 1 },
      { background: true, name: 'creatorId_videoId_idx' }
    );

    // Index for creators collection
    const creators = db.collection('creators');
    await creators.createIndex(
      { slug: 1 },
      { background: true, unique: true, name: 'slug_unique_idx' }
    );
  } catch (error) {
    // Indexes may already exist, that's fine
    console.warn('Index creation warning (may already exist):', error instanceof Error ? error.message : String(error));
  }
}

// Separate connection for orgs database (read-only access for validation)
let orgsClient: MongoClient;
let orgsClientPromise: Promise<MongoClient>;

const orgsUri = Bun.env.ORGS_DATABASE_URL;
if (!orgsUri) {
  throw new Error('ORGS_DATABASE_URL environment variable is required');
}

if (env.NODE_ENV === 'development') {
  const globalWithOrgs = global as typeof globalThis & {
    _orgsClientPromise?: Promise<MongoClient>;
  };

  if (!globalWithOrgs._orgsClientPromise) {
    orgsClient = new MongoClient(orgsUri, options);
    globalWithOrgs._orgsClientPromise = orgsClient.connect();
  }
  orgsClientPromise = globalWithOrgs._orgsClientPromise;
} else {
  orgsClient = new MongoClient(orgsUri, options);
  orgsClientPromise = orgsClient.connect();
}

export async function connectToOrgsDatabase(): Promise<{ client: MongoClient; db: Db }> {
  const client = await orgsClientPromise;
  const db = client.db('orgs');
  return { client, db };
}

// Connection to Prisma database (same cluster as orgs, different database)
export async function connectToPrismaDatabase(): Promise<{ client: MongoClient; db: Db }> {
  const client = await orgsClientPromise; // Same cluster/connection as orgs
  const db = client.db('prisma');
  return { client, db };
}

export { clientPromise };


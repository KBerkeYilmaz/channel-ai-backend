import { connectToDatabase } from './src/lib/mongodb';

async function fixSlug() {
  const { db } = await connectToDatabase();

  // Find the creator with wrong slug
  const creator = await db.collection('creators').findOne({
    slug: 'kutalm-berke-y-lmaz'
  });

  if (!creator) {
    console.log('Creator not found with old slug');
    return;
  }

  console.log('Found creator:', {
    _id: creator._id,
    name: creator.name,
    oldSlug: creator.slug
  });

  // Generate correct slug
  const creatorName = creator.name;
  const correctSlug = creatorName
    // Turkish character replacements (uppercase first)
    .replace(/Ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/Ş/g, 's')
    .replace(/İ/g, 'i')
    .replace(/Ö/g, 'o')
    .replace(/Ç/g, 'c')
    // Then lowercase
    .toLowerCase()
    // Turkish lowercase characters
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    // Normalize other unicode characters
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Replace spaces and special chars with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');

  console.log('New slug:', correctSlug);

  // Update the slug
  const result = await db.collection('creators').updateOne(
    { _id: creator._id },
    { $set: { slug: correctSlug } }
  );

  console.log('Update result:', result);
  console.log('✅ Slug fixed successfully!');

  process.exit(0);
}

fixSlug().catch(error => {
  console.error('Error fixing slug:', error);
  process.exit(1);
});

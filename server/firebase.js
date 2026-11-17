import admin from 'firebase-admin';

let firestore = null;
let authMode = 'sqlite-fallback';
const hasServiceAccountKey = Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
const hasApplicationDefaultCredentials = Boolean(process.env.FIREBASE_PROJECT_ID);

if (hasServiceAccountKey || hasApplicationDefaultCredentials) {
  try {
    const credential = hasServiceAccountKey
      ? admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      : admin.credential.applicationDefault();
    admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
    });
    firestore = admin.firestore();
    authMode = hasServiceAccountKey ? 'service-account-key' : 'application-default-credentials';
    console.log(`Firebase Firestore enabled via ${authMode}`);
  } catch (error) {
    console.warn(`Firebase disabled: ${error.message}`);
  }
} else {
  console.log('Firebase not configured; using local SQLite fallback');
}

export const firebaseEnabled = () => Boolean(firestore);
export const firebaseInfo = () => ({ enabled: Boolean(firestore), provider: firestore ? 'firestore' : 'sqlite-fallback', auth: authMode, projectId: process.env.FIREBASE_PROJECT_ID || null });

export async function firebaseGet(collection, id) {
  if (!firestore) return null;
  const snapshot = await firestore.collection(collection).doc(String(id)).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function firebaseList(collection) {
  if (!firestore) return [];
  const snapshot = await firestore.collection(collection).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function firebaseUpsert(collection, id, data) {
  if (!firestore) return;
  try { await firestore.collection(collection).doc(String(id)).set({ ...data, syncedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
  catch (error) { console.warn(`Firebase write skipped: ${error.message}`); }
}

export async function firebaseDelete(collection, id) {
  if (!firestore) return;
  try { await firestore.collection(collection).doc(String(id)).delete(); }
  catch (error) { console.warn(`Firebase delete skipped: ${error.message}`); }
}

export async function firebaseFindUserByEmail(email) {
  if (!firestore) return null;
  const snapshot = await firestore.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

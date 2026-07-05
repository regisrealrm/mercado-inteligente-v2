import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyCncOkX9o0pXJVwZtqtnnhaiOHU3V1FHZE",
  authDomain: "mercado-inteligente-v2.firebaseapp.com",
  projectId: "mercado-inteligente-v2",
  storageBucket: "mercado-inteligente-v2.firebasestorage.app",
  messagingSenderId: "1029743599674",
  appId: "1:1029743599674:web:f284874f47ef76d74b5503"
}

export const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)

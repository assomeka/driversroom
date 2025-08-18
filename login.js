import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// 🔧 Config Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDJ7uhvc31nyRB4bh9bVtkagaUksXG1fOo",
  authDomain: "estacupbymeka.firebaseapp.com",
  projectId: "estacupbymeka",
  storageBucket: "estacupbymeka.firebasestorage.app",
  messagingSenderId: "1065406380441",
  appId: "1:1065406380441:web:55005f7d29290040c13b08"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 🧠 Fonction pour formater le nom et prénom
function formatName(firstName, lastName) {
  const prenom = firstName.trim().toLowerCase();
  const nom = lastName.trim().toLowerCase();
  return {
    firstName: prenom.charAt(0).toUpperCase() + prenom.slice(1),
    lastName: nom.toUpperCase()
  };
}

// 🔐 Connexion
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorBox = document.getElementById("error");

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (userDoc.exists()) {
      const data = userDoc.data();
      if (data.admin === true) {
        window.location.href = "admin.html";
      } else {
        window.location.href = "dashboard.html";
      }
    } else {
      const mapDoc = await getDoc(doc(db, "authMap", user.uid));
      if (mapDoc.exists()) {
        window.location.href = "dashboard.html";
      } else {
        errorBox.textContent = "Profil introuvable.";
      }
    }
  } catch (err) {
    errorBox.textContent = err.message;
  }
});

// 🔁 Toggle affichage formulaire inscription
document.getElementById("showRegister").addEventListener("click", () => {
  document.getElementById("registerSection").classList.toggle("hidden");
});

// 📝 Inscription
document.getElementById("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const rawFirstName = document.getElementById("firstName").value;
  const rawLastName = document.getElementById("lastName").value;
  const dob = document.getElementById("dob").value;
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirm = document.getElementById("confirmPassword").value;
  const errorBox = document.getElementById("error");

  if (password !== confirm) {
    errorBox.textContent = "Les mots de passe ne correspondent pas.";
    return;
  }

  const { firstName, lastName } = formatName(rawFirstName, rawLastName);

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const firebaseUser = userCredential.user;

    const allUsers = await getDocs(collection(db, "users"));
    const existing = allUsers.docs.find(docu => {
      const d = docu.data();
      return d.firstName === firstName && d.lastName === lastName;
    });

    if (existing) {
      // 🔗 Mappe l’utilisateur Auth vers le document existant
      await setDoc(doc(db, "authMap", firebaseUser.uid), {
        pilotUid: existing.id
      });
      await setDoc(doc(db, "users", existing.id), {
        ...existing.data(),
        email,
        uid: existing.id
      });
    } else {
      // 🆕 Nouveau pilote
      await setDoc(doc(db, "users", firebaseUser.uid), {
        uid: firebaseUser.uid,
        email,
        firstName,
        lastName,
        dob,
        licenseId: "PILOT-" + Math.random().toString(36).substring(2, 6).toUpperCase(),
        eloRating: 1000,
        licensePoints: 10,
        raceCount: 0,
        createdAt: new Date(),
        admin: false
      });
    }

    window.location.href = "dashboard.html";
  } catch (err) {
    errorBox.textContent = err.message;
  }
});

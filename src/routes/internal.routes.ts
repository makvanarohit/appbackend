import { Router } from 'express';
import { createUser, listUsers, updateUser } from '../controllers/staff-admin.controller';
import {
    confirmTwoFactor,
    login,
    logout,
    setupTwoFactor,
    verifyTwoFactor,
} from '../controllers/staff-auth.controller';
import { openStore } from '../controllers/support.controller';
import { staffLoginLimiter } from '../middleware/rate-limit';
import { requireAdmin, verifyStaff } from '../middleware/verify-staff';

// Mounted at /internal in app.ts. That place already adds the IP list, the CORS check for your
// frontend, the Origin check, the JSON parser and the cookie parser.
const router = Router();

// ---- Staff login (public steps) ----
router.post('/staff/login', staffLoginLimiter, login);
router.post('/staff/2fa/verify', staffLoginLimiter, verifyTwoFactor);
router.post('/staff/2fa/setup', setupTwoFactor);
router.post('/staff/2fa/confirm', staffLoginLimiter, confirmTwoFactor);
router.post('/staff/logout', logout);

// ---- Staff management (admin only) ----
router.get('/staff/users', verifyStaff, requireAdmin, listUsers);
router.post('/staff/users', verifyStaff, requireAdmin, createUser);
router.patch('/staff/users/:id', verifyStaff, requireAdmin, updateUser);

// ---- Support: look at one shop (any logged-in staff member) ----
router.post('/support/sessions', verifyStaff, openStore);

export default router;

// In production, set TRUST_PROXY right, or the IP list and the rate limits see only the proxy's address.
// The staff cookie works only when your frontend and backend are on the same site (for example app.yourapp.com and api.yourapp.com). Locally the Vite proxy makes it work.
// With STAFF_REQUIRE_2FA=false on your own computer, the password alone logs you in. It is refused on every other environment.

// Test with Postman (it keeps cookies by itself). Every POST needs this header: Origin: http://localhost:5173 (your APP_FRONTEND_URL). Postman does not send it, and without it you get 403. Also add Content-Type: application/json. In this test I assume your backend runs on port 3000.
// POST http://localhost:3000/internal/staff/login with {"username":"admin","password":"<the password from create-admin>"}. The answer is {"next":"setup"}.
// POST http://localhost:3000/internal/staff/2fa/setup with no body. The answer has secret and qrCodeDataUrl. The easy way: in Google Authenticator choose "Enter a setup key", and type the secret. Or paste the qrCodeDataUrl text into your browser address bar to see the QR picture and scan it.
// POST http://localhost:3000/internal/staff/2fa/confirm with {"code":"123456"} (use the real 6 digits from the app). The answer has "next":"done", and the session cookie is saved.
// POST http://localhost:3000/internal/staff/logout. The answer is {"success":true}.
// Log in again (step 1). Now the answer is {"next":"verify"}. Send POST /internal/staff/2fa/verify with the next code from the app. If you send the same code that you used in step 3, you get "This code was already used".
// Optional lock test: 5 wrong passwords lock the account for 15 minutes. If you lock yourself, run this in MySQL: UPDATE staff_users SET locked_until = NULL, failed_login_count = 0;

// In Postman, log in as your admin (login, then the 2FA code). Your session lasts 30 minutes, so log in again if it ends. Every POST and PATCH needs the header Origin: http://localhost:5173, and Content-Type: application/json.
// GET http://localhost:3000/internal/staff/users. You see a list with your admin.
// POST http://localhost:3000/internal/staff/users with {"username":"rahul","password":"a-long-password-123","role":"support"}. The answer is 201, and it has "totpEnabled": false.
// Check the new user: POST /internal/staff/login with the username and password. The answer is {"next":"setup"}. This is what the staff member does at the first login.
// PATCH http://localhost:3000/internal/staff/users/2 (use the real staffId) with {"status":"disabled"}. Then log in as that user. You get a refusal.
// Other bodies to try: {"status":"active"}, {"password":"another-long-password-1"}, {"resetTwoFactor":true}. Send only one per request.
// Try PATCH on your own id with {"status":"disabled"}. You get 400, and nothing changes.

// Things to know
// If an admin changes their own password or resets their own 2FA, they are logged out at once, because that ends all of their sessions. This is on purpose.
// The admin who creates a user knows the first password. Send it through a safe channel, not a group chat. Later I can add a "change my password" option for staff.
// A user locked by wrong tries is shown with "isLocked": true. Setting a new password unlocks them.
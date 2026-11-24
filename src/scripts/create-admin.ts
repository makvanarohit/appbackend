// Makes the FIRST admin. Run it once, on a computer that can reach the database.
//
//   Local:       npm run staff:create-admin -- --username admin
//   On a server: node dist/scripts/create-admin.js --username admin
//
// It makes a random password and prints it ONCE. Save it now: it is not stored in plain text.
// The admin sets up 2FA at the first login.

import { pool } from '../config/database';
import { env } from '../config/env';
import { isValidUsername, normalizeUsername, USERNAME_RULE_MESSAGE } from '../models/staff.model';
import { createStaffUser, StaffUsernameTakenError } from '../repositories/staff.repository';
import { generatePassword, hashPassword } from '../services/password.service';

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
    const username = normalizeUsername(readArg('username') ?? '');
    if (!isValidUsername(username)) {
        console.error(`${USERNAME_RULE_MESSAGE}.`);
        console.error('Example: npm run staff:create-admin -- --username admin');
        process.exitCode = 1;
        return;
    }

    const password = generatePassword();

    try {
        await createStaffUser({ username, passwordHash: await hashPassword(password), role: 'admin' });
    } catch (err) {
        if (err instanceof StaffUsernameTakenError) {
            console.error(`The username "${username}" already exists.`);
            process.exitCode = 1;
            return;
        }
        throw err;
    }

    console.log('');
    console.log(`Admin created (${env.appEnv}).`);
    console.log(`  Username: ${username}`);
    console.log(`  Password: ${password}`);
    console.log('');
    console.log('Save this password now. It is shown only once.');
    console.log(
        env.staff.require2fa
            ? 'The admin sets up 2FA at the first login.'
            : 'STAFF_REQUIRE_2FA is false, so 2FA is skipped on this local machine.',
    );
}

main()
    .catch((err) => {
        console.error('Could not create the admin:', err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
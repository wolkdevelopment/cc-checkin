# Central Committee Check-In (beta)

PCOs check in by showing a QR code on their phone. The door scans it with a phone camera and shows the answer full-screen: hand a voting card, give a badge only, or send them to the Sergeant-at-Arms. Officers see who's here and whether there's a quorum, live, on any phone or laptop. Every action goes into a tamper-evident log, and the roll downloads as a spreadsheet.

It runs on Netlify the same way as the bylaws site: Netlify Functions plus Netlify Blobs storage. There's no database to set up and no outside services.

## Set it up on Netlify (about 15 minutes)

1. **Make a new private GitHub repository** and upload what's *inside* the `cc-checkin` folder. Unzip the download, open the `cc-checkin` folder, select everything in it, and drag that onto GitHub's **Add file → Upload files** page. `netlify.toml` must end up at the top of the repository, not inside a `cc-checkin` folder. If `.nvmrc` or `.gitignore` gets left out, that's fine.
2. **In Netlify, add a new project from that repository** (Add new project → Import an existing project → GitHub). Leave the build settings alone; Netlify reads them from `netlify.toml`.
3. **Set the admin key.** In the project's settings, open Environment variables and add `ADMIN_KEY`, a password of at least 12 characters. As on the bylaws site, leave **Contains secret values** unticked.
4. **Redeploy** (Deploys → Trigger deploy) so the function picks up the key.
5. **Open `https://your-site.netlify.app/admin`** and sign in with the key.

Optional setting: `TIMEZONE` (default `America/Los_Angeles`), used for times in the downloaded roll.

## Test it with two phones and a laptop

1. **Laptop:** on the admin page, choose **Set it up** with the sample roster. It's 210 fictional people across seven districts, with one of each tricky case in LD 27.
2. **Phone 1:** on the **Test with your phones** tab, tap **Can vote**. Scan the QR code with Phone 1's camera app and open the link. Phone 1 now shows that PCO's credential.
3. **Phone 2:** tap **Make a door link**, scan that QR code with Phone 2, and open the link. Tap **Start scanning** and allow the camera.
4. **Laptop:** tap **Open the live board**.
5. **Point Phone 2 at Phone 1's code.** It turns green: "Hand card 101." Tap **Check in**. Within about three seconds, Phone 1 changes to "Checked in · Voting card 101" and the board shows one voting member present.

Then try:

- **Scan the same code again.** The door says "Already checked in, don't admit." Sending them to the Sergeant-at-Arms puts it on the board.
- **Dues question.** Pick **Dues not on record** for Phone 1 and scan its new code. The door sends the question to the Sergeant-at-Arms, who settles it on the board with **Paid at the door** (which hands the next voting card) or **Can't vote today**.
- **Other cases.** Try **Appointed 41 days ago**, **Precinct Captain** and **Inactive** to see how the door treats each one.
- **Find by name** on Phone 2, for someone without a phone, and **Add a guest**.
- **Check in 40 test people** on the admin page. Then, on the board, **Call the meeting to order** and **Declare quorum**. Check-in closes (4.7.4.B), and the door shows it. **Reopen check-in** undoes that.
- **District Chair view.** On the Devices tab, make a District Chair link for LD 27 and open it on a phone. It shows that caucus's quorum and who's missing, and can mark absent PCOs inactive.
- **The roll.** On Records, download it (CSV), and tap **Check the log** to verify that no entry was changed after it was written.

A phone holds one PCO credential at a time: the last link it opened.

## How it decides who can vote

| Who | Votes? | Bylaw |
| --- | --- | --- |
| Elected PCO | Yes | 2.1 |
| Appointed PCO | After 60 days from appointment | 2.2.1.D |
| Elected CC officer who isn't a PCO | Yes | 1.2 |
| Precinct Captain | No; takes part | 2.4 |
| Appointed officer | No | 5.5 |
| Party member | No | 1.2 |
| PCO marked inactive by their District Chair | No | 2.6 |
| Dues not on record | The Sergeant-at-Arms or Chair rules | SR B, 5.4.6 |

- **Quorum** is 45% of the members who can vote, leaving out absentees who missed the previous two meetings (4.4.1). Someone who missed both but shows up counts again, which raises the number needed.
- **District caucus quorums** use the same rule within each district (SR J.3).
- **Check-in closes** when the Chair declares quorum, unless the Chair keeps it open (4.7.4.B).
- **Paper sign-in** can be ordered from the board, and paper prevails (4.7.6).
- **The log** is the auditable record (4.7.2). The downloaded roll is the official roll (4.7.5.B).

## Before you use it for a real meeting

- **Approval.** The Executive Board approves the check-in platform and its written procedures (4.7.3.C). Test with the sample roster until then.
- **Treat links like keys.** A PCO's credential link and an officer's device link each work for whoever holds them. Sign out a lost device on the Devices tab, and reissue a person's code on the People tab (the old one stops working at once).
- **Where the data lives.** Only in Netlify Blobs on your Netlify account. The site is hidden from search engines and has no public pages listing anyone.

## What this beta doesn't do yet

- Load the real roster from a spreadsheet. For now, use the sample roster or add people one at a time.
- Send credential links by email. **Email it** opens your mail app with the message ready.
- Proxies (4.5) and ballots.
- Scan with no signal. The door phone needs a connection.
- Track attendance history automatically. "Missed the last two meetings" is set by hand on the People tab.

## Costs

Pages check for changes only while the screen is on:

| Screen | Checks for changes |
| --- | --- |
| Live board | Every 2 seconds |
| Door | Every 4 seconds |
| PCO's page | Every 3 seconds, stopping once they're checked in |

A test with your three devices uses roughly one Netlify credit an hour. A real meeting with about 10 officer screens and 150 PCO phones would use roughly 20. Each deploy costs 15 credits, so batch your changes. These figures assume the Free plan's pricing as of this fall: 300 credits a month, 2 credits per 10,000 requests, 10 credits per GB-hour of function time.

## What's in the folder

| Path | What it is |
| --- | --- |
| `site/index.html`, `site/app.css` | The one page every screen uses |
| `site/js/pages/` | The screens: `admin`, `me` (a PCO's credential), `door`, `board` (live board), `join` (device sign-in), `home` |
| `site/js/qr.js` | QR codes: the encoder, and the camera decoder (no outside libraries) |
| `site/js/camera.js` | The door's camera. It uses the phone's built-in reader where there is one (most Android phones) and `qr.js` otherwise (iPhones) |
| `site/js/rules.js` | Who can vote and what makes a quorum. The server and the pages share it, so they always agree |
| `netlify/functions/api.mjs` | The one function, for every `/api/` request |
| `netlify/lib/core.mjs` | The server: sign-in, credentials, check-in, rulings, the Chair, the log, the roll |
| `netlify/lib/sample.mjs` | The fictional sample roster |
| `dev/` | A local server with in-memory storage |
| `test/` | Automated tests |

## Run it on your computer

Install Node 22. Then run `npm run dev` in this folder and open http://localhost:8888/admin. The key is `local-admin-key`, and data is lost when you stop the server. The camera works on `localhost`.

`npm test` runs the automated tests (17). They cover:

- Two doors scanning the same person at once: exactly one check-in.
- Thirty simultaneous check-ins: card numbers 101 to 130 with none lost.
- Altered and replaced codes.
- Dues rulings and the Chair's controls.
- The log's chain.
- Scanning rotated, tilted and blurred codes.

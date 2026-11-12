# PagePoster Desktop

PagePoster is a Windows application for preparing and reviewing pages and publishing them to WordPress sites you are authorized to manage.

- Download the clean Windows ZIP from [Releases](https://github.com/JulianME28/PagePoster/releases). Extract the entire folder and open PagePoster.exe.
- [User guide (Ukrainian)](docs/USER-GUIDE.uk.md)

The public package starts without projects, saved connections, Google Sheets, WordPress credentials, API keys, or a bundled Google OAuth client. Configure your own connections in Settings. To use Google browser sign-in, build with your own Desktop OAuth client configuration. Alternatively, use the service-account option for your own Google Sheets.

To develop on Windows, use Node.js 24 and run pnpm install --frozen-lockfile. To stage a build with browser sign-in, run node scripts/configure-google-client.cjs with the path to your Desktop OAuth configuration, then node scripts/build-desktop.cjs. Keep the local OAuth file outside version control.

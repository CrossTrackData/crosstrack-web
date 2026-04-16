# CrossTrack Web SDK

[![v0.1.0](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/CrossTrackData/crosstrack-web) [![License](https://img.shields.io/badge/license-proprietary-lightgrey)](https://crosstrackdata.com)

Lightweight identity resolution SDK for websites. Tracks visitor IDs, manages sessions, and stitches user identity across platforms.

3 KB minified. Zero dependencies.

## Installation

```html
<script src="https://app.crosstrackdata.com/crosstrack.js"></script>
```

## Quick Start

```html
<script>
  CrossTrack.init({
    apiKey: 'YOUR_API_KEY',
    collectionUrl: 'https://crosstrack.onrender.com'
  });
  CrossTrack.consent('opted_in');

  // Track events
  CrossTrack.track('page_view');

  // When user logs in
  CrossTrack.identify('user_123', { email_hash: 'sha256...' });
</script>
```

## Features

- Persistent visitor ID (localStorage)
- Session management (30-min timeout)
- Three-state consent (opted_in, opted_out, not_set)
- Event queue with batched flush
- WebView bridge pickup (reads device ID from native app)
- Cross-domain URL decoration
- identify() with traits

## Get Your API Key

Sign up free at [app.crosstrackdata.com](https://app.crosstrackdata.com)

## Links

- [Landing Page](https://crosstrackdata.com)
- [Live Demo](https://crosstrack-demo.onrender.com)

# v0.1.0

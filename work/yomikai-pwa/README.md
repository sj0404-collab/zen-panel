# Yomihon PWA - Android Manga Reader

A Progressive Web App for reading manga on Android devices using Expo and React Native.

## Project Structure

```
yomikai-pwa/
├── app/                  # Expo configuration and assets
├── src/
│   ├── App.tsx           # Root component with navigation
│   ├── screens/
│   │   ├── HomeScreen.tsx    # Main menu with Library/Reader/Settings
│   │   ├── ReaderScreen.tsx  # Page viewer with scrollable images
│   │   └── LibraryScreen.tsx # Book library grid
│   ├── components/     # Reusable UI components
│   ├── hooks/          # Custom React hooks
│   ├── constants/      # App constants and configurations
│   └── global.css      # Global styles
├── package.json          # Dependencies and scripts
├── app.json             # Expo configuration
└── README.md           # This file
```

## Features

- **Home Screen**: Main entry point with navigation to Library, Reader, and Settings
- **Library Screen**: Grid of book covers with titles and authors
- **Reader Screen**: Scrollable page viewer with image support
- **Navigation**: React Navigation with stack navigator
- **Font Loading**: Uses expo-font for custom font rendering
- **PWA Support**: Configured for web deployment via `expo start --web`

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm start

# Run on Android
npm run android

# Run on web
npm run web
```

## Dependencies

Key dependencies installed:
- `expo` - Expo framework
- `expo-router` - File-based routing
- `@react-navigation/native` - Navigation library
- `expo-font` - Font loading
- `expo-splash-screen` - Splash screen handling
- `react-native-screens` - Performance optimization
- `react-native-safe-area-context` - Safe area handling

## Development

This project uses Expo Go for quick iteration. For production builds:

```bash
# Create Android build
expo build:android

# Create web build  
expo build:web
```

## License

MIT

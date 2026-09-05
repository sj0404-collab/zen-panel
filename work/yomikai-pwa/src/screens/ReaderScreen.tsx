import * as React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Dimensions, ScrollView } from 'react-native';
import { useFonts } from 'expo-font';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function ReaderScreen({ navigation }: any) {
  const [fontsLoaded] = useFonts({
    'roboto': require('@expo/vector-icons/fonts/Roboto.ttf'),
  });

  if (!fontsLoaded) {
    return <Text style={{ fontSize: 16, margin: 20 }}>Loading fonts...</Text>;
  }

  // Mock pages data - in real app this would come from local files
  const pages = [
    { id: 1, image: 'https://picsum.photos/400/600?random=1' },
    { id: 2, image: 'https://picsum.photos/400/600?random=2' },
    { id: 3, image: 'https://picsum.photos/400/600?random=3' },
    { id: 4, image: 'https://picsum.photos/400/600?random=4' },
  ];

  return (
    <ScrollView contentContainerStyle={styles.scrollContainer}>
      {pages.map((page) => (
        <View key={page.id} style={styles.pageContainer}>
          <Image source={{ uri: page.image }} style={styles.pageImage} />
          <Text style={styles.pageText}>Страница {page.id}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    padding: 20,
  },
  pageContainer: {
    marginBottom: 20,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  pageImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_WIDTH * 1.6,
    resizeMode: 'cover',
  },
  pageText: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 6,
    borderRadius: 4,
    fontSize: 14,
  },
});

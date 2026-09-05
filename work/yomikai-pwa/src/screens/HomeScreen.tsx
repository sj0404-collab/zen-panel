import * as React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Dimensions } from 'react-native';
import { useFonts } from 'expo-font';
import { MaterialIcons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function HomeScreen({ navigation }: any) {
  const [fontsLoaded] = useFonts({
    'roboto': require('@expo/vector-icons/fonts/Roboto.ttf'),
    'roboto-medium': require('@expo/vector-icons/fonts/Roboto-Medium.ttf'),
  });

  if (!fontsLoaded) {
    return <Text>Loading fonts...</Text>;
  }

  return (
    <View style={styles.container}>
      <MaterialIcons name="book" size={80} color="#6750a4" />
      <View style={styles.titleArea}>
        <Text style={styles.title}>Yomihon</Text>
        <Text style={styles.subtitle}>Manga Reader</Text>
      </View>
      <TouchableOpacity style={styles.btnBrowse} onPress={() => navigation.navigate('Library')}>
        <Text style={styles.btnText}>Открыть библиотеку</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btnRead} onPress={() => navigation.navigate('Reader')}>
        <Text style={styles.btnText}>Прочитать</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btnSettings} onPress={() => navigation.navigate('Settings')}>
        <Text style={styles.btnText}>Настройки</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#6750a4',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#888',
    marginBottom: 32,
  },
  titleArea: {
    alignItems: 'center',
    marginBottom: 40,
  },
  btnBrowse: {
    backgroundColor: '#6750a4',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginBottom: 12,
  },
  btnText: {
    color: 'white',
    fontWeight: 'bold',
  },
  btnRead: {
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginBottom: 12,
  },
  btnSettings: {
    backgroundColor: '#2196F3',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
});

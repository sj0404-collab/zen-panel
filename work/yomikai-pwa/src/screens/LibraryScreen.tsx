import * as React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Image, ScrollView, ActivityIndicator } from 'react-native';
import { useFonts } from 'expo-font';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export default function LibraryScreen({ navigation }: any) {
  const [fontsLoaded] = useFonts({
    'roboto': require('@expo/vector-icons/fonts/Roboto.ttf'),
    'roboto-medium': require('@expo/vector-icons/fonts/Roboto-Medium.ttf'),
  });

  const [books, setBooks] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // Mock books data - in real app this would load from local storage or API
    const mockBooks = [
      { id: 1, title: 'Чистый код', author: 'Роберт Мартин', cover: 'https://picsum.photos/100/150?random=1' },
      { id: 2, title: 'TypeScript Handbook', author: 'Microsoft', cover: 'https://picsum.photos/100/150?random=2' },
      { id: 3, title: 'React Docs', author: 'React Team', cover: 'https://picsum.photos/100/150?random=3' },
      { id: 4, title: 'Expo Guide', author: 'Expo Team', cover: 'https://picsum.photos/100/150?random=4' },
    ];
    setBooks(mockBooks);
    setLoading(false);
  }, []);

  if (!fontsLoaded) {
    return <Text style={{ fontSize: 16, margin: 20 }}>Loading fonts...</Text>;
  }

  if (loading) {
    return <ScrollView><ActivityIndicator size="large" /></ScrollView>;
  }

  return (
    <ScrollView>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Моя библиотека</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => alert('Добавить книгу')}>
          <Text style={styles.addText}>+</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={books}
        keyExtractor={(item) => item.id.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.bookItem} onPress={() => navigation.navigate('Reader')}>
            <View style={styles.bookCover}>
              <Image source={{ uri: item.cover }} style={styles.coverImage} />
            </View>
            <View style={styles.bookInfo}>
              <Text style={styles.bookTitle}>{item.title}</Text>
              <Text style={styles.bookAuthor}>{item.author}</Text>
            </View>
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.listContainer}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  addBtn: {
    color: '#6750a4',
    fontSize: 16,
    fontWeight: 'bold',
  },
  addText: {
    marginLeft: 4,
  },
  listContainer: {
    padding: 20,
  },
  bookItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  bookCover: {
    width: 80,
    height: 120,
    borderRadius: 8,
    marginRight: 16,
    overflow: 'hidden',
  },
  coverImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  bookInfo: {
    flex: 1,
  },
  bookTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  bookAuthor: {
    fontSize: 12,
    color: '#666',
  },
});

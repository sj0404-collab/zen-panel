import * as React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { Text, View, StyleSheet } from 'react-native';
import { useWeb } from 'expo-web';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Intl from 'expo-intl';

const Stack = createStackNavigator();

export default function App() {
  const { isWeb } = useWeb();
  
  return (
    <NavigationContainer linking={Linking.createLinking()}>
      <StatusBar style="auto" />
      <Stack.Navigator initialRouteName="Home" screenOptions="headerShown">
        <Stack.Screen name="Home">
          {() => (
            <View style={styles.center}>
              <Text style={styles.title}>Yomihon PWA</Text>
              <Text style={styles.subtitle}>Android manga reader in the browser</Text>
            </View>
          )}
        </Stack.Screen>
        <Stack.Screen name="Reader">
          {() => <Text>Reader Screen</Text>}
        </Stack.Screen>
        <Stack.Screen name="Library">
          {() => <Text>Library Screen</Text>}
        </Stack.Screen>
        <Stack.Screen name="Settings">
          {() => <Text>Settings Screen</Text>}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});

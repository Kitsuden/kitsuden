// Kitsuden client for Kotlin (JVM and Android). Not part of the pnpm workspace.
//
//   gradle test        (or ./gradlew test once a wrapper is generated with `gradle wrapper`)
plugins {
    kotlin("jvm") version "2.0.21"
    `java-library`
}

group = "dev.kitsuden"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    // HttpURLConnection is used for HTTP: it exists on the JVM and on Android,
    // unlike java.net.http. Only coroutines and a JSON tree are needed.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}

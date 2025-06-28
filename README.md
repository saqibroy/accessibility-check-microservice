# 🚀 Accessibility Checker Microservice

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.x-blue?style=for-the-badge&logo=express)](https://expressjs.com/)
[![Axe-core](https://img.shields.io/badge/Axe--core-4.x-purple?style=for-the-badge&logo=axe&logoColor=white)](https://www.deque.com/axe/)
[![JSDOM](https://img.shields.io/badge/JSDOM-24.x-orange?style=for-the-badge&logo=jsdom&logoColor=white)](https://github.com/jsdom/jsdom)
[![Deployment](https://img.shields.io/badge/Deployed%20on-Render-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://render.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

---

## 📖 Table of Contents

* [🌟 Overview](#-overview)
* [✨ Features](#-features)
* [🛠️ Technologies Used](#️-technologies-used)
* [🚀 Getting Started](#-getting-started)
    * [Prerequisites](#prerequisites)
    * [Installation](#installation)
    * [Running Locally](#running-locally)
    * [Local Testing](#local-testing)
* [☁️ Deployment](#️-deployment)
    * [Render Deployment Guide](#render-deployment-guide)
* [⚙️ API Endpoints](#️-api-endpoints)
    * [`POST /check-accessibility-static`](#post-check-accessibility-static)
    * [`GET /health`](#get-health)
    * [`POST /test-connectivity`](#post-test-connectivity)
* [🔧 Configuration](#-configuration)
* [🤝 Contributing](#-contributing)
* [📄 License](#-license)
* [📧 Contact](#-contact)

---

## 🌟 Overview

This repository hosts a lightweight and efficient Node.js microservice designed to perform static accessibility analysis on web pages. Leveraging `axe-core` and `JSDOM`, it fetches the HTML content of a given URL and audits it for common accessibility violations based on WCAG 2.1 A and AA standards, without the overhead of a full browser (like Puppeteer/Playwright).

This microservice is intended to be used as a backend component for a frontend application (e.g., a Next.js app), which can then consume the raw accessibility data and further enrich it (e.g., using an AI model for detailed explanations and fix suggestions, as demonstrated in `ssohail.com/blog`).

## ✨ Features

* **Static Accessibility Analysis:** Audits HTML content using `axe-core` without a headless browser, significantly reducing resource consumption and improving speed.
* **WCAG 2.1 A/AA Compliance:** Focuses on detecting violations based on essential accessibility guidelines.
* **Robust HTML Fetching:** Uses `axios` with comprehensive error handling for reliable content retrieval.
* **JSDOM Integration:** Simulates a browser DOM environment to accurately run `axe-core`.
* **API Endpoints:** Provides dedicated endpoints for accessibility checks, health status, and connectivity testing.
* **Input Validation:** Ensures secure and proper URL input.
* **Error Handling:** Detailed error responses for fetching, analysis, and network issues.
* **CORS Enabled:** Configured for cross-origin requests, allowing seamless integration with frontend applications.
* **Graceful Shutdown:** Implements proper process termination.

## 🛠️ Technologies Used

* **Node.js:** JavaScript runtime environment
* **Express.js:** Fast, unopinionated, minimalist web framework
* **Axios:** Promise-based HTTP client for the browser and Node.js
* **JSDOM:** A JavaScript implementation of the WHATWG DOM and HTML standards, for use in Node.js
* **Axe-core:** The accessibility testing engine for web applications
* **Dotenv:** Loads environment variables from a `.env` file

## 🚀 Getting Started

Follow these instructions to get a copy of the project up and running on your local machine for development and testing purposes.

### Prerequisites

* Node.js (v18 or higher recommended)
* npm (comes with Node.js)
* Git

### Installation

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/your-username/accessibility-microservice.git](https://github.com/your-username/accessibility-microservice.git)
    cd accessibility-microservice
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```

### Running Locally

1.  **Create a `.env` file:**
    In the root of the project directory, create a file named `.env`. This file will be used to load environment variables for local development.
    ```
    PORT=3001
    NODE_ENV=development
    ```
    (Note: No `GEMINI_API_KEY` is needed here, as AI processing is handled by the frontend.)

2.  **Start the microservice:**
    ```bash
    npm start
    ```
    The service will start on the port specified in your `.env` file (defaulting to `3001`). You should see a message like:
    `[YYYY-MM-DDTHH:MM:SS.sssZ] Accessibility Microservice listening on port 3001`

### Local Testing

You can test the API endpoints using `curl` or a tool like Postman/Insomnia.

**Test `POST /check-accessibility-static`:**

```bash
curl -X POST -H "Content-Type: application/json" -d '{"url": "[https://www.google.com](https://www.google.com)"}' http://localhost:3001/check-accessibility-static
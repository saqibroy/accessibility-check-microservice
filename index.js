// accessibility-microservice/index.js
import express from 'express';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import dotenv from 'dotenv';
import http from 'node:http';
import https from 'node:https';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Configure HTTP agents with more lenient settings for local testing
const httpAgent = new http.Agent({
    keepAlive: false, // Disable keepAlive for better compatibility
    timeout: 30000,
    maxSockets: 10,
    maxFreeSockets: 10
});

const httpsAgent = new https.Agent({
    keepAlive: false, // Disable keepAlive for better compatibility
    timeout: 30000,
    maxSockets: 10,
    maxFreeSockets: 10
});

// Configure axios defaults
axios.defaults.timeout = 30000; // Increased timeout
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

app.use(express.json({ limit: '10mb' }));

// Enhanced CORS configuration
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Input validation middleware
const validateUrl = (req, res, next) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ 
            success: false,
            message: 'URL is required',
            error: 'MISSING_URL'
        });
    }

    try {
        const parsedUrl = new URL(url);
        // Ensure protocol is http or https
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ 
                success: false,
                message: 'Only HTTP and HTTPS URLs are supported',
                error: 'INVALID_PROTOCOL'
            });
        }
        req.validatedUrl = parsedUrl.toString();
        next();
    } catch (error) {
        return res.status(400).json({ 
            success: false,
            message: 'Invalid URL format',
            error: 'INVALID_URL_FORMAT'
        });
    }
};

// Error handling middleware
const handleError = (error, req, res, next) => {
    console.error('Error:', error);
    
    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'SERVER_ERROR'
    });
};

app.post('/check-accessibility-static', validateUrl, async (req, res) => {
    const url = req.validatedUrl;
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] Starting accessibility check for: ${url}`);

    let htmlContent;
    try {
        console.log('Fetching HTML content...');
        
        // First, let's test basic connectivity
        console.log('Testing connectivity to:', url);
        
        const response = await axios.get(url, {
            timeout: 30000, // 30 seconds
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            validateStatus: (status) => status < 500, // Accept all responses except server errors
            // Don't use custom agents, let axios handle it
            httpAgent: undefined,
            httpsAgent: undefined,
        });

        htmlContent = response.data;
        console.log(`HTML fetched successfully (${response.status}). Content length: ${htmlContent.length} characters`);

    } catch (error) {
        console.error('Detailed fetch error:', {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            statusText: error.response?.statusText,
            url: url,
            stack: error.stack
        });

        if (axios.isAxiosError(error)) {
            if (error.response) {
                // Server responded with error status
                return res.status(400).json({
                    success: false,
                    message: `Server responded with ${error.response.status}: ${error.response.statusText}`,
                    error: 'HTTP_ERROR',
                    statusCode: error.response.status,
                    url: url
                });
            } else if (error.request) {
                // Network error - provide more helpful message
                let networkMessage = 'Network error: Unable to reach the server.';
                let suggestions = [];
                
                if (error.code === 'ETIMEDOUT') {
                    networkMessage = 'Request timed out. The server took too long to respond.';
                    suggestions.push('Try a faster responding website');
                    suggestions.push('Check your internet connection');
                } else if (error.code === 'ENOTFOUND') {
                    networkMessage = 'DNS resolution failed. The domain name could not be found.';
                    suggestions.push('Check if the URL is correct');
                    suggestions.push('Try a different URL');
                } else if (error.code === 'ECONNREFUSED') {
                    networkMessage = 'Connection refused. The server is not accepting connections.';
                    suggestions.push('Check if the website is online');
                }
                
                return res.status(500).json({
                    success: false,
                    message: networkMessage,
                    error: 'NETWORK_ERROR',
                    details: error.code || 'CONNECTION_FAILED',
                    suggestions: suggestions,
                    url: url
                });
            }
        }

        // General error
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch URL content',
            error: 'FETCH_ERROR',
            details: error.message,
            url: url
        });
    }

    // Validate HTML content
    if (!htmlContent || typeof htmlContent !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'No valid HTML content received from URL',
            error: 'INVALID_CONTENT',
            url: url
        });
    }

    // Run accessibility analysis
    let axeResults;
    try {
        console.log('Initializing JSDOM and running accessibility analysis...');
        
        const dom = new JSDOM(htmlContent, {
            url: url,
            runScripts: "dangerously",
            resources: "usable",
            pretendToBeVisual: true
        });
        
        const { window } = dom;
        const { document } = window;

        // Inject axe-core into the JSDOM window
        const axeSource = `
            ${axe.source};
            window.axeResults = null;
            window.axeError = null;
            
            axe.run(document, {
                runOnly: {
                    type: 'tag',  
                    values: ['wcag2a', 'wcag2aa']
                },
                resultTypes: ['violations', 'incomplete', 'passes'],
                elementRef: false
            }).then(function(results) {
                window.axeResults = results;
            }).catch(function(error) {
                window.axeError = error.message;
            });
        `;

        // Execute axe in the JSDOM context
        window.eval(axeSource);

        // Wait for results with timeout
        const startTime = Date.now();
        const timeout = 30000; // 30 seconds

        while (!window.axeResults && !window.axeError && (Date.now() - startTime) < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
        }

        if (window.axeError) {
            throw new Error(window.axeError);
        }

        if (!window.axeResults) {
            throw new Error('Accessibility analysis timeout after 30 seconds');
        }

        axeResults = window.axeResults;

        console.log(`Accessibility analysis completed. Found ${axeResults.violations.length} violations`);
        
        // Clean up DOM
        window.close();

    } catch (error) {
        console.error('Accessibility analysis error:', {
            message: error.message,
            stack: error.stack
        });
        
        return res.status(500).json({
            success: false,
            message: 'Failed to perform accessibility analysis',
            error: 'ANALYSIS_ERROR',
            details: error.message,
            url: url
        });
    }

    const endTime = Date.now();
    const processingTime = endTime - startTime;

    console.log(`[${new Date().toISOString()}] Accessibility check completed in ${processingTime}ms`);

    // Return structured response
    return res.status(200).json({
        success: true,
        data: {
            url: url,
            timestamp: new Date().toISOString(),
            processingTimeMs: processingTime,
            summary: {
                totalViolations: axeResults.violations.length,
                totalPasses: axeResults.passes.length,
                totalIncomplete: axeResults.incomplete.length
            },
            violations: axeResults.violations.map(violation => ({
                id: violation.id,
                impact: violation.impact,
                description: violation.description,
                help: violation.help,
                helpUrl: violation.helpUrl,
                tags: violation.tags,
                nodes: violation.nodes.map(node => ({
                    html: node.html,
                    target: node.target,
                    failureSummary: node.failureSummary
                }))
            })),
            passes: axeResults.passes.length, // Just count for performance
            incomplete: axeResults.incomplete.map(incomplete => ({
                id: incomplete.id,
                impact: incomplete.impact,
                description: incomplete.description,
                help: incomplete.help,
                helpUrl: incomplete.helpUrl,
                tags: incomplete.tags,
                nodes: incomplete.nodes.length // Just count for performance
            }))
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'accessibility-microservice',
        version: process.env.npm_package_version || '1.0.0'
    });
});

// Simple connectivity test endpoint
app.post('/test-connectivity', validateUrl, async (req, res) => {
    const url = req.validatedUrl;
    
    try {
        console.log(`Testing connectivity to: ${url}`);
        
        const response = await axios.head(url, {
            timeout: 10000,
            validateStatus: () => true, // Accept any status code
            httpAgent: undefined,
            httpsAgent: undefined,
        });
        
        res.status(200).json({
            success: true,
            url: url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            message: 'Successfully connected to the URL'
        });
        
    } catch (error) {
        console.error('Connectivity test failed:', error.message);
        
        res.status(500).json({
            success: false,
            url: url,
            error: error.code || 'UNKNOWN_ERROR',
            message: error.message,
            details: 'Failed to connect to the URL'
        });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        error: 'NOT_FOUND'
    });
});

// Global error handler
app.use(handleError);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
        process.exit(0);
    });
});

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Accessibility Microservice listening on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
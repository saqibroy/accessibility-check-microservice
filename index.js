// accessibility-microservice/index.js
import express from 'express';
import axios from 'axios';
import { JSDOM, VirtualConsole } from 'jsdom';
import axe from 'axe-core';
import dotenv from 'dotenv';
import http from 'node:http';
import https from 'node:https';
import { promisify } from 'util';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Configuration constants
const CONFIG = {
    MAX_HTML_SIZE: 10 * 1024 * 1024, // 10MB max HTML size
    MAX_CONTENT_LENGTH: 50 * 1024 * 1024, // 50MB max content length
    REQUEST_TIMEOUT: 45000, // 45 seconds
    ANALYSIS_TIMEOUT: 60000, // 60 seconds for analysis
    MAX_DOM_ELEMENTS: 10000, // Maximum DOM elements to analyze
    MEMORY_LIMIT_MB: 512, // Memory limit in MB
};

// Memory monitoring
let peakMemoryUsage = 0;
const monitorMemory = () => {
    const usage = process.memoryUsage();
    const currentMB = usage.heapUsed / 1024 / 1024;
    peakMemoryUsage = Math.max(peakMemoryUsage, currentMB);
    
    if (currentMB > CONFIG.MEMORY_LIMIT_MB) {
        console.warn(`⚠️  High memory usage detected: ${currentMB.toFixed(2)}MB`);
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }
    }
};

// Monitor memory every 5 seconds
setInterval(monitorMemory, 5000);

// Configure HTTP agents with optimized settings
const httpAgent = new http.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 5,
    maxFreeSockets: 2
});

const httpsAgent = new https.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 5,
    maxFreeSockets: 2,
    rejectUnauthorized: false // Handle some SSL issues
});

// Configure axios with strict limits
axios.defaults.timeout = CONFIG.REQUEST_TIMEOUT;
axios.defaults.maxContentLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.maxBodyLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

app.use(express.json({ limit: '1mb' })); // Reduced JSON limit

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

// HTML content sanitizer and size checker
const sanitizeAndValidateHtml = (htmlContent, url) => {
    if (!htmlContent || typeof htmlContent !== 'string') {
        throw new Error('No valid HTML content received');
    }

    const sizeInBytes = Buffer.byteLength(htmlContent, 'utf8');
    const sizeInMB = sizeInBytes / (1024 * 1024);

    console.log(`HTML content size: ${sizeInMB.toFixed(2)}MB`);

    if (sizeInBytes > CONFIG.MAX_HTML_SIZE) {
        console.warn(`⚠️  Large HTML detected (${sizeInMB.toFixed(2)}MB), truncating...`);
        // Truncate to manageable size while preserving structure
        const truncatedHtml = htmlContent.substring(0, CONFIG.MAX_HTML_SIZE);
        // Try to close any open tags to avoid parsing issues
        return truncatedHtml + '</body></html>';
    }

    return htmlContent;
};

// Improved accessibility analysis with better resource management
const runAccessibilityAnalysis = async (htmlContent, url) => {
    return new Promise((resolve, reject) => {
        let dom = null;
        let analysisTimeout = null;
        
        try {
            console.log('🔍 Initializing JSDOM with security restrictions...');
            
            // Create JSDOM with minimal resource usage
            dom = new JSDOM(htmlContent, {
                url: url,
                runScripts: "outside-only", // Changed from "dangerously"
                resources: "usable",
                pretendToBeVisual: true,
                virtualConsole: new VirtualConsole().sendTo(console, { omitJSDOMErrors: true })
            });
            
            const { window } = dom;
            const { document } = window;

            // Count DOM elements for complexity assessment
            const elementCount = document.querySelectorAll('*').length;
            console.log(`📊 DOM elements found: ${elementCount}`);

            if (elementCount > CONFIG.MAX_DOM_ELEMENTS) {
                console.warn(`⚠️  Large DOM detected (${elementCount} elements), may impact performance`);
            }

            // Set analysis timeout
            analysisTimeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Analysis timeout after ${CONFIG.ANALYSIS_TIMEOUT / 1000} seconds`));
            }, CONFIG.ANALYSIS_TIMEOUT);

            // More efficient axe execution
            const axeSource = `
                try {
                    ${axe.source};
                    
                    // Configure axe for better performance on large sites
                    axe.configure({
                        rules: [{
                            id: 'bypass',
                            enabled: true
                        }, {
                            id: 'color-contrast',
                            enabled: true
                        }, {
                            id: 'focus-order-semantics',
                            enabled: false // Disable expensive rules for large sites
                        }]
                    });

                    axe.run(document, {
                        runOnly: {
                            type: 'tag',  
                            values: ['wcag2a', 'wcag2aa']
                        },
                        resultTypes: ['violations', 'incomplete'],
                        elementRef: false,
                        selectors: false, // Reduce memory usage
                        ancestry: false,  // Reduce memory usage
                        xpath: false      // Reduce memory usage
                    }).then(function(results) {
                        // Limit results to prevent memory issues
                        const limitedResults = {
                            violations: results.violations.slice(0, 100), // Limit to 100 violations
                            incomplete: results.incomplete.slice(0, 50),  // Limit to 50 incomplete
                            passes: results.passes.length, // Just count
                            url: results.url,
                            timestamp: results.timestamp
                        };
                        
                        // Clean up nodes data to reduce memory
                        limitedResults.violations.forEach(violation => {
                            if (violation.nodes) {
                                violation.nodes = violation.nodes.slice(0, 10).map(node => ({
                                    html: node.html ? node.html.substring(0, 200) : '',
                                    target: Array.isArray(node.target) ? node.target.slice(0, 3) : node.target,
                                    failureSummary: node.failureSummary ? node.failureSummary.substring(0, 300) : ''
                                }));
                            }
                        });

                        window.axeResults = limitedResults;
                    }).catch(function(error) {
                        window.axeError = error.message;
                    });
                } catch (error) {
                    window.axeError = error.message;
                }
            `;

            // Execute axe analysis
            window.eval(axeSource);

            // Use more efficient polling with exponential backoff
            let pollAttempts = 0;
            const maxPollAttempts = 300; // 30 seconds max
            const pollInterval = 100; // Start with 100ms

            const checkResults = () => {
                pollAttempts++;
                
                if (window.axeResults) {
                    cleanup();
                    resolve(window.axeResults);
                    return;
                }
                
                if (window.axeError) {
                    cleanup();
                    reject(new Error(window.axeError));
                    return;
                }
                
                if (pollAttempts >= maxPollAttempts) {
                    cleanup();
                    reject(new Error('Analysis polling timeout'));
                    return;
                }
                
                // Exponential backoff for polling
                const nextInterval = Math.min(pollInterval * Math.pow(1.1, pollAttempts), 1000);
                setTimeout(checkResults, nextInterval);
            };

            const cleanup = () => {
                if (analysisTimeout) {
                    clearTimeout(analysisTimeout);
                    analysisTimeout = null;
                }
                if (dom && dom.window) {
                    dom.window.close();
                    dom = null;
                }
                // Force garbage collection
                if (global.gc) {
                    global.gc();
                }
            };

            // Start polling
            setTimeout(checkResults, pollInterval);

        } catch (error) {
            if (analysisTimeout) clearTimeout(analysisTimeout);
            if (dom && dom.window) dom.window.close();
            reject(error);
        }
    });
};

// Error handling middleware
const handleError = (error, req, res, next) => {
    console.error('❌ Error:', error);
    
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
    const initialMemory = process.memoryUsage().heapUsed / 1024 / 1024;

    console.log(`\n🚀 [${new Date().toISOString()}] Starting accessibility check for: ${url}`);
    console.log(`💾 Initial memory usage: ${initialMemory.toFixed(2)}MB`);

    let htmlContent;
    try {
        console.log('🌐 Fetching HTML content...');
        
        const response = await axios.get(url, {
            timeout: CONFIG.REQUEST_TIMEOUT,
            maxRedirects: 3, // Reduce redirects
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AccessibilityBot/1.0)',
                'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Connection': 'close' // Prevent connection reuse
            },
            validateStatus: (status) => status >= 200 && status < 400,
            responseType: 'text'
        });

        htmlContent = sanitizeAndValidateHtml(response.data, url);
        console.log(`✅ HTML fetched successfully (${response.status}). Processing ${htmlContent.length} characters`);

    } catch (error) {
        console.error('❌ Fetch error:', {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            url: url
        });

        if (axios.isAxiosError(error)) {
            if (error.response) {
                return res.status(400).json({
                    success: false,
                    message: `Server responded with ${error.response.status}: ${error.response.statusText}`,
                    error: 'HTTP_ERROR',
                    statusCode: error.response.status,
                    url: url
                });
            }
            
            let networkMessage = 'Network error occurred';
            if (error.code === 'ETIMEDOUT') {
                networkMessage = 'Request timed out - website may be too slow or complex';
            } else if (error.code === 'ENOTFOUND') {
                networkMessage = 'Domain not found - check URL spelling';
            }
            
            return res.status(500).json({
                success: false,
                message: networkMessage,
                error: 'NETWORK_ERROR',
                details: error.code,
                url: url
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch URL content',
            error: 'FETCH_ERROR',
            details: error.message,
            url: url
        });
    }

    // Run accessibility analysis with improved error handling
    let axeResults;
    try {
        console.log('🔍 Running accessibility analysis...');
        const beforeAnalysisMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`💾 Memory before analysis: ${beforeAnalysisMemory.toFixed(2)}MB`);
        
        axeResults = await runAccessibilityAnalysis(htmlContent, url);
        
        const afterAnalysisMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`💾 Memory after analysis: ${afterAnalysisMemory.toFixed(2)}MB`);
        console.log(`✅ Analysis completed. Found ${axeResults.violations.length} violations`);
        
    } catch (error) {
        console.error('❌ Analysis error:', error.message);
        
        return res.status(500).json({
            success: false,
            message: 'Failed to perform accessibility analysis',
            error: 'ANALYSIS_ERROR',
            details: error.message,
            url: url,
            suggestion: 'This website may be too complex for analysis. Try a simpler page or contact support.'
        });
    }

    const endTime = Date.now();
    const processingTime = endTime - startTime;
    const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024;

    console.log(`✅ [${new Date().toISOString()}] Accessibility check completed in ${processingTime}ms`);
    console.log(`💾 Final memory usage: ${finalMemory.toFixed(2)}MB (Peak: ${peakMemoryUsage.toFixed(2)}MB)`);

    // Return structured response with performance metrics
    return res.status(200).json({
        success: true,
        data: {
            url: url,
            timestamp: new Date().toISOString(),
            processingTimeMs: processingTime,
            performance: {
                memoryUsedMB: finalMemory.toFixed(2),
                peakMemoryMB: peakMemoryUsage.toFixed(2),
                htmlSizeKB: Math.round(htmlContent.length / 1024)
            },
            summary: {
                totalViolations: axeResults.violations.length,
                totalIncomplete: axeResults.incomplete.length,
                totalPasses: axeResults.passes,
                isLargeWebsite: htmlContent.length > 1024 * 1024 // > 1MB
            },
            violations: axeResults.violations,
            incomplete: axeResults.incomplete,
            metadata: {
                analysisLimited: axeResults.violations.length >= 100,
                truncatedHtml: htmlContent.length >= CONFIG.MAX_HTML_SIZE
            }
        }
    });
});

// Health check endpoint with memory info
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();
    
    res.status(200).json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'accessibility-microservice',
        version: process.env.npm_package_version || '1.0.0',
        uptime: `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`,
        memory: {
            heapUsedMB: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
            heapTotalMB: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
            peakUsageMB: peakMemoryUsage.toFixed(2)
        }
    });
});

// Enhanced connectivity test
app.post('/test-connectivity', validateUrl, async (req, res) => {
    const url = req.validatedUrl;
    
    try {
        console.log(`🔗 Testing connectivity to: ${url}`);
        
        const response = await axios.head(url, {
            timeout: 10000,
            validateStatus: () => true,
            maxRedirects: 3
        });
        
        res.status(200).json({
            success: true,
            url: url,
            status: response.status,
            statusText: response.statusText,
            contentLength: response.headers['content-length'],
            contentType: response.headers['content-type'],
            server: response.headers['server'],
            message: 'Successfully connected to the URL'
        });
        
    } catch (error) {
        console.error('❌ Connectivity test failed:', error.message);
        
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

// Graceful shutdown with cleanup
const gracefulShutdown = () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('✅ HTTP server closed');
        
        // Cleanup agents
        httpAgent.destroy();
        httpsAgent.destroy();
        
        console.log('✅ Process terminated');
        process.exit(0);
    });
    
    // Force shutdown after 30 seconds
    setTimeout(() => {
        console.log('❌ Forced shutdown');
        process.exit(1);
    }, 30000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown();
});

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 [${new Date().toISOString()}] Accessibility Microservice listening on port ${port}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⚙️  Configuration: Max HTML ${CONFIG.MAX_HTML_SIZE / 1024 / 1024}MB, Timeout ${CONFIG.REQUEST_TIMEOUT / 1000}s`);
});

// Increase server timeout for complex websites
server.timeout = CONFIG.REQUEST_TIMEOUT + 10000; // Add 10s buffer
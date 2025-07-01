const express = require('express');
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const axe = require('axe-core');
const dotenv = require('dotenv');
const http = require('node:http');
const https = require('node:https');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Enhanced configuration constants
const CONFIG = {
    MAX_HTML_SIZE: 3 * 1024 * 1024, // Reduced to 3MB max HTML size
    MAX_CONTENT_LENGTH: 5 * 1024 * 1024, // Reduced to 5MB max content length
    REQUEST_TIMEOUT: 20000, // Reduced to 20 seconds
    ANALYSIS_TIMEOUT: 30000, // Reduced to 30 seconds for analysis
    MAX_DOM_ELEMENTS: 3000, // Further reduced maximum DOM elements
    MEMORY_LIMIT_MB: 200, // Much lower memory limit for 512MB environment
    COMPLEX_SITE_THRESHOLD: 1000, // Lower threshold
    JSDOM_TIMEOUT: 15000, // Reduced JSDOM timeout
    MAX_VIOLATIONS_TO_PROCESS: 30, // Limit violations processed
    MAX_NODES_PER_VIOLATION: 5, // Limit nodes per violation
    ENABLE_GC_AGGRESSIVE: true // Enable aggressive garbage collection
};

let peakMemoryUsage = 0; // Initialize peakMemoryUsage for tracking

// Enhanced memory monitoring with more aggressive cleanup
const monitorMemory = () => {
    const usage = process.memoryUsage();
    const currentMB = usage.heapUsed / 1024 / 1024;
    const totalMB = usage.heapTotal / 1024 / 1024;

    peakMemoryUsage = Math.max(peakMemoryUsage, currentMB);

    console.log(`💾 Memory: ${currentMB.toFixed(1)}MB used / ${totalMB.toFixed(1)}MB total`);

    // More aggressive memory management for low-memory environments
    if (currentMB > CONFIG.MEMORY_LIMIT_MB) {
        console.warn(`⚠️ High memory usage: ${currentMB.toFixed(2)}MB - forcing cleanup`);

        // Multiple garbage collection cycles
        if (global.gc) {
            for (let i = 0; i < 3; i++) {
                global.gc();
            }
        }

        // Additional cleanup steps
        if (typeof process.nextTick === 'function') {
            process.nextTick(() => {
                if (global.gc) global.gc();
            });
        }
    }

    // Emergency cleanup if memory gets too high
    if (currentMB > 400) { // 400MB threshold for 512MB system
        console.error(`🚨 CRITICAL MEMORY USAGE: ${currentMB.toFixed(2)}MB - emergency cleanup`);

        // Force immediate garbage collection
        if (global.gc) {
            for (let i = 0; i < 5; i++) {
                global.gc();
            }
        }

        // Consider process restart warning
        if (currentMB > 450) {
            console.error('💀 Memory usage critical - service may need restart');
        }
    }
};

// More frequent memory monitoring for resource-constrained environment
setInterval(monitorMemory, 2000);

// More aggressive HTTP agents for memory efficiency
const httpAgent = new http.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 2, // Reduced further
    maxFreeSockets: 0 // No free sockets
});

const httpsAgent = new https.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 2, // Reduced further
    maxFreeSockets: 0, // No free sockets
    rejectUnauthorized: false
});

// Configure axios with stricter limits
axios.defaults.timeout = CONFIG.REQUEST_TIMEOUT;
axios.defaults.maxContentLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.maxBodyLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.maxRedirects = 1;

app.use(express.json({ limit: '500kb' }));

// Enhanced CORS configuration
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
    res.setHeader('Content-Type', 'application/json');

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

// Enhanced error response function
const sendErrorResponse = (res, status, message, error, details = null, url = null) => {
    res.setHeader('Content-Type', 'application/json');

    const errorResponse = {
        success: false,
        message,
        error,
        timestamp: new Date().toISOString()
    };

    if (details) errorResponse.details = details;
    if (url) errorResponse.url = url;

    console.error(`❌ Error Response [${status}]:`, errorResponse);
    return res.status(status).json(errorResponse);
};

// Enhanced HTML sanitizer for memory efficiency
const sanitizeAndValidateHtml = (htmlContent, url) => {
    if (!htmlContent || typeof htmlContent !== 'string') {
        throw new Error('No valid HTML content received');
    }

    const sizeInBytes = Buffer.byteLength(htmlContent, 'utf8');
    const sizeInMB = sizeInBytes / (1024 * 1024);

    console.log(`📄 HTML content size: ${sizeInMB.toFixed(2)}MB`);

    if (sizeInBytes > CONFIG.MAX_HTML_SIZE) {
        console.warn(`⚠️ Large HTML detected (${sizeInMB.toFixed(2)}MB), truncating aggressively...`);
        // More aggressive truncation
        const truncatedHtml = htmlContent.substring(0, CONFIG.MAX_HTML_SIZE);
        // Ensure we end with proper closing tags
        return truncatedHtml + '</main></body></html>';
    }

    // Aggressive cleaning for memory efficiency
    let cleanedHtml = htmlContent;
    console.log('🧹 Cleaning HTML for memory efficiency...');
    cleanedHtml = cleanedHtml
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove all scripts
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove inline styles
        .replace(/<link[^>]*rel=['"]?stylesheet['"]?[^>]*>/gi, '') // Remove stylesheets
        .replace(/on\w+=['"][^'"]*['"]/gi, '') // Remove event handlers
        .replace(/style=['"][^'"]*['"]/gi, '') // Remove inline styles
        .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '') // Remove iframes
        .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '') // Remove objects
        .replace(/<embed[^>]*>/gi, '') // Remove embeds
        .replace(/<video[^>]*>[\s\S]*?<\/video>/gi, '') // Remove videos
        .replace(/<audio[^>]*>[\s\S]*?<\/audio>/gi, '') // Remove audio
        .replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/gi, '') // Remove canvas
        .replace(/<!--[\s\S]*?-->/g, '') // Remove comments
        .replace(/<meta[^>]*>/gi, '') // Remove meta tags
        .replace(/<link[^>]*(?!rel=['"]?icon['"]?)[^>]*>/gi, ''); // Remove non-icon links

    const finalSize = Buffer.byteLength(cleanedHtml, 'utf8') / (1024 * 1024);
    console.log(`✅ HTML cleaned: ${finalSize.toFixed(2)}MB (reduced by ${(sizeInMB - finalSize).toFixed(2)}MB)`);

    return cleanedHtml;
};

const runAccessibilityAnalysis = async (htmlContent, url) => {
    return new Promise((resolve, reject) => {
        let dom = null;
        let analysisTimeout = null;
        let jsdomTimeout = null;
        let isCompleted = false;

        const cleanup = () => {
            if (isCompleted) return;
            isCompleted = true;

            if (analysisTimeout) {
                clearTimeout(analysisTimeout);
                analysisTimeout = null;
            }
            if (jsdomTimeout) {
                clearTimeout(jsdomTimeout);
                jsdomTimeout = null;
            }
            if (dom && dom.window) {
                try {
                    dom.window.close();
                } catch (closeError) {
                    console.warn('Error closing JSDOM window:', closeError.message);
                }
                dom = null;
            }
            // Aggressive garbage collection
            if (global.gc) {
                global.gc();
                setTimeout(() => global.gc(), 100);
            }
        };

        try {
            console.log('🔍 Initializing JSDOM with strict security restrictions...');

            const virtualConsole = new VirtualConsole();
            virtualConsole.on("error", () => {});
            virtualConsole.on("warn", () => {});
            virtualConsole.on("jsdomError", () => {});

            jsdomTimeout = setTimeout(() => {
                cleanup();
                reject(new Error('JSDOM initialization timeout - site too complex'));
            }, CONFIG.JSDOM_TIMEOUT);

            dom = new JSDOM(htmlContent, {
                url: url,
                // Change runScripts to "dangerously" if "outside-only" still causes issues for axe-core's internal script execution.
                // "dangerously" is needed for axe-core to function as it expects scripts to run.
                // We're disabling external scripts via beforeParse, so this is about its internal operation.
                runScripts: "dangerously", // This is crucial for axe-core to set up its environment
                resources: "usable",
                pretendToBeVisual: false,
                virtualConsole: virtualConsole,
                beforeParse(window) {
                    window.alert = () => {};
                    window.confirm = () => false;
                    window.prompt = () => null;
                    window.open = () => null;
                    window.setTimeout = () => 0;
                    window.setInterval = () => 0;
                    window.requestAnimationFrame = () => 0;
                    window.fetch = () => Promise.reject(new Error('fetch is disabled'));
                    window.XMLHttpRequest = class { constructor() { throw new Error('XMLHttpRequest is disabled'); } };
                    // IMPORTANT: You might need to set window.Node for axe to work correctly in JSDOM:
                    // window.Node = global.Node; // Ensure Node is available if axe needs it globally
                }
            });

            if (jsdomTimeout) {
                clearTimeout(jsdomTimeout);
                jsdomTimeout = null;
            }

            const { window } = dom; // Get the window object from the JSDOM instance
            const { document } = window; // Get the document object from the JSDOM window

            const elementCount = document.querySelectorAll('*').length;
            console.log(`📊 DOM elements found: ${elementCount}`);

            if (elementCount > CONFIG.MAX_DOM_ELEMENTS) {
                cleanup();
                reject(new Error(`Website too complex: ${elementCount} DOM elements (max: ${CONFIG.MAX_DOM_ELEMENTS}). Try a simpler page.`));
                return;
            }

            const isComplexSite = elementCount > CONFIG.COMPLEX_SITE_THRESHOLD;
            const actualTimeout = CONFIG.ANALYSIS_TIMEOUT;

            console.log(`🏗️ Site complexity: ${isComplexSite ? 'HIGH' : 'NORMAL'} (timeout: ${actualTimeout/1000}s)`);

            analysisTimeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Analysis timeout after ${actualTimeout / 1000} seconds - website too complex`));
            }, actualTimeout);


            // Configure axe-core directly against the JSDOM window
            const axeConfig = {
                rules: [
                    { id: 'bypass', enabled: true },
                    { id: 'color-contrast', enabled: false },
                    { id: 'focus-order-semantics', enabled: false },
                    { id: 'scrollable-region-focusable', enabled: false },
                    { id: 'css-orientation-lock', enabled: false }
                ]
            };

            const axeOptions = {
                runOnly: {
                    type: 'tag',
                    values: ['wcag2a', 'wcag2aa']
                },
                resultTypes: ['violations', 'incomplete'],
                elementRef: false,
                selectors: false,
                ancestry: false,
                xpath: false,
                performanceTimer: true
            };

            // CRITICAL FIX: Pass the JSDOM window object to axe.run()
            console.log('🚀 Running axe analysis using axe.run(window.document, options) from JSDOM instance...');

            // The 'axe' module needs to be initialized with the JSDOM window context.
            // This is typically done with `axe.configure` or by binding axe to the window.
            // The simplest is to ensure `axe` is available in the JSDOM window.
            // However, the standard Node.js integration for axe-core with JSDOM is to pass the document or window directly.

            // Let's re-try the simpler method based on axe-core's documentation:
            // axe.run() expects a context (element or document) and then options.
            // If it's a global axe, it would pick up window.document.
            // Since we're in Node, we explicitly provide the JSDOM's document.

            // One common issue is that axe-core itself needs `Node` or other globals to be available
            // on the JSDOM window. Let's ensure that and explicitly bind axe to the window for it to work.

            // The most robust way with axe-core in JSDOM is often:
            axe.Source.inject(window.document); // Inject axe source into the JSDOM window's document. This is different from axe.source!

            // Now, configure and run axe within that JSDOM context.
            // This might require a small `eval` or a direct call *after* injection.
            window.eval(`
                if (window.axe) {
                    window.axe.configure(${JSON.stringify(axeConfig)});
                    window.axe.run(window.document, ${JSON.stringify(axeOptions)})
                        .then(results => {
                            window._axeResults = results; // Store results for Node.js to retrieve
                        })
                        .catch(err => {
                            window._axeError = err.message; // Store error
                        });
                } else {
                    window._axeError = 'axe-core not found in JSDOM window after injection.';
                }
            `);

            // Now, poll for the results from the JSDOM window, similar to your original design's polling
            let pollAttempts = 0;
            const maxPollAttempts = actualTimeout / 100; // Poll every 100ms up to timeout
            const pollInterval = 100;

            const checkResults = () => {
                if (isCompleted) return;

                pollAttempts++;

                if (window._axeResults) {
                    cleanup();
                    resolve(window._axeResults);
                    return;
                }

                if (window._axeError) {
                    cleanup();
                    reject(new Error(window._axeError));
                    return;
                }

                if (pollAttempts >= maxPollAttempts) {
                    cleanup();
                    reject(new Error('Analysis polling timeout: axe.run did not complete in JSDOM context.'));
                    return;
                }

                setTimeout(checkResults, pollInterval);
            };
            setTimeout(checkResults, pollInterval);


        } catch (error) {
            cleanup();
            reject(new Error('JSDOM initialization failed: ' + error.message));
        }
    });
};

// Enhanced error handling middleware
const handleError = (error, req, res, next) => {
    console.error('❌ Unhandled Error:', error);

    if (res.headersSent) {
        return next(error);
    }

    return sendErrorResponse(
        res,
        500,
        'Internal server error',
        'SERVER_ERROR',
        process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
    );
};

app.post('/check-accessibility-static', validateUrl, async (req, res) => {
    const url = req.validatedUrl;
    const startTime = Date.now();
    const initialMemory = process.memoryUsage().heapUsed / 1024 / 1024;

    console.log(`\n🚀 [${new Date().toISOString()}] Starting accessibility check for: ${url}`);
    console.log(`💾 Initial memory usage: ${initialMemory.toFixed(2)}MB`);

    // Force garbage collection before starting
    if (global.gc) {
        global.gc();
        const afterGcMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`💾 Memory after GC: ${afterGcMemory.toFixed(2)}MB`);
    }

    // Check if we have enough memory to proceed
    if (initialMemory > 300) {
        console.warn(`⚠️ High initial memory usage: ${initialMemory.toFixed(2)}MB - may fail`);

        if (global.gc) {
            for (let i = 0; i < 3; i++) {
                global.gc();
            }
        }

        const cleanedMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        if (cleanedMemory > 250) {
            return sendErrorResponse(
                res,
                503,
                'Service temporarily unavailable due to high memory usage',
                'MEMORY_EXHAUSTED',
                'Please try again in a few moments'
            );
        }
    }

    let htmlContent;
    try {
        console.log('🌐 Fetching HTML content...');

        const response = await axios.get(url, {
            timeout: CONFIG.REQUEST_TIMEOUT,
            maxRedirects: 1,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AccessibilityBot/1.0)',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'Cache-Control': 'no-cache',
                'Connection': 'close'
            },
            validateStatus: (status) => status >= 200 && status < 400,
            responseType: 'text'
        });

        const afterFetchMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`💾 Memory after fetch: ${afterFetchMemory.toFixed(2)}MB`);

        htmlContent = sanitizeAndValidateHtml(response.data, url);
        console.log(`✅ HTML fetched and cleaned. Processing ${htmlContent.length} characters`);

        const afterCleanMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`💾 Memory after HTML cleanup: ${afterCleanMemory.toFixed(2)}MB`);

    } catch (error) {
        console.error('❌ Fetch error:', {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            url: url
        });

        if (axios.isAxiosError(error)) {
            if (error.response) {
                return sendErrorResponse(
                    res,
                    400,
                    `Server responded with ${error.response.status}: ${error.response.statusText}`,
                    'HTTP_ERROR',
                    error.response.status,
                    url
                );
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
            suggestion: error.message.includes('too complex')
                ? 'This website is too complex for analysis. Try analyzing a specific page instead of the homepage.'
                : 'Analysis failed due to website complexity or timeout. Please try again or contact support.'
        });
    }

    const endTime = Date.now();
    const processingTime = endTime - startTime;
    const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024;

    console.log(`✅ [${new Date().toISOString()}] Accessibility check completed in ${processingTime}ms`);
    console.log(`💾 Final memory usage: ${finalMemory.toFixed(2)}MB (Peak: ${peakMemoryUsage.toFixed(2)}MB)`);

    // Force cleanup after completion
    if (global.gc) {
        global.gc();
    }

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
                htmlSizeKB: Math.round(htmlContent.length / 1024),
                analysisTimeMs: axeResults.analysisTimeMs || 0
            },
            summary: {
                totalViolations: axeResults.violations.length,
                totalIncomplete: axeResults.incomplete.length,
                totalPasses: axeResults.passes,
                isComplexWebsite: htmlContent.length > 1024 * 1024,
                resultsTruncated: axeResults.violations.length >= CONFIG.MAX_VIOLATIONS_TO_PROCESS
            },
            violations: axeResults.violations,
            incomplete: axeResults.incomplete,
            metadata: {
                analysisLimited: axeResults.violations.length >= CONFIG.MAX_VIOLATIONS_TO_PROCESS,
                truncatedHtml: htmlContent.length >= CONFIG.MAX_HTML_SIZE,
                complexSiteOptimizations: htmlContent.length > 1024 * 1024
            }
        }
    });
});

// Health check endpoint with enhanced memory info
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();

    // Force garbage collection for health check
    if (global.gc) {
        global.gc();
    }

    const memAfterGC = process.memoryUsage();

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
            peakUsageMB: peakMemoryUsage.toFixed(2),
            afterGcMB: (memAfterGC.heapUsed / 1024 / 1024).toFixed(2)
        },
        config: {
            maxHtmlSizeMB: CONFIG.MAX_HTML_SIZE / 1024 / 1024,
            maxDomElements: CONFIG.MAX_DOM_ELEMENTS,
            analysisTimeoutSec: CONFIG.ANALYSIS_TIMEOUT / 1000
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

// Enhanced graceful shutdown with memory cleanup
const gracefulShutdown = () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('✅ HTTP server closed');

        // Cleanup agents
        httpAgent.destroy();
        httpsAgent.destroy();

        // Force final garbage collection
        if (global.gc) {
            global.gc();
            global.gc();
        }

        console.log('✅ Process terminated');
        process.exit(0);
    });

    // Force shutdown after 20 seconds
    setTimeout(() => {
        console.log('❌ Forced shutdown');
        process.exit(1);
    }, 20000);
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
    console.log(`⚙️ Configuration: Max HTML ${CONFIG.MAX_HTML_SIZE / 1024 / 1024}MB, Max DOM ${CONFIG.MAX_DOM_ELEMENTS}, Timeout ${CONFIG.ANALYSIS_TIMEOUT / 1000}s`);
});

// Increase server timeout
server.timeout = CONFIG.REQUEST_TIMEOUT + 15000;

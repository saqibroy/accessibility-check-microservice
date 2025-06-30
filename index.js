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

// Enhanced configuration constants
const CONFIG = {
    MAX_HTML_SIZE: 5 * 1024 * 1024, // Reduced to 5MB max HTML size
    MAX_CONTENT_LENGTH: 20 * 1024 * 1024, // Reduced to 20MB max content length
    REQUEST_TIMEOUT: 30000, // Reduced to 30 seconds
    ANALYSIS_TIMEOUT: 45000, // Reduced to 45 seconds for analysis
    MAX_DOM_ELEMENTS: 5000, // Reduced maximum DOM elements to analyze
    MEMORY_LIMIT_MB: 300, // Reduced memory limit
    COMPLEX_SITE_THRESHOLD: 2000, // DOM elements threshold for complex sites
    JSDOM_TIMEOUT: 30000, // Specific timeout for JSDOM operations
};

// Memory monitoring with forced cleanup
let peakMemoryUsage = 0;
const monitorMemory = () => {
    const usage = process.memoryUsage();
    const currentMB = usage.heapUsed / 1024 / 1024;
    peakMemoryUsage = Math.max(peakMemoryUsage, currentMB);
    
    if (currentMB > CONFIG.MEMORY_LIMIT_MB) {
        console.warn(`⚠️  High memory usage detected: ${currentMB.toFixed(2)}MB - forcing cleanup`);
        // Force multiple garbage collections
        if (global.gc) {
            global.gc();
            global.gc(); // Double GC for better cleanup
        }
    }
};

// Monitor memory every 3 seconds (more frequent)
setInterval(monitorMemory, 3000);

// More aggressive HTTP agents
const httpAgent = new http.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 3, // Reduced
    maxFreeSockets: 1 // Reduced
});

const httpsAgent = new https.Agent({
    keepAlive: false,
    timeout: CONFIG.REQUEST_TIMEOUT,
    maxSockets: 3, // Reduced
    maxFreeSockets: 1, // Reduced
    rejectUnauthorized: false
});

// Configure axios with stricter limits
axios.defaults.timeout = CONFIG.REQUEST_TIMEOUT;
axios.defaults.maxContentLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.maxBodyLength = CONFIG.MAX_CONTENT_LENGTH;
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

app.use(express.json({ limit: '500kb' })); // Further reduced JSON limit

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

// More aggressive HTML sanitizer
const sanitizeAndValidateHtml = (htmlContent, url) => {
    if (!htmlContent || typeof htmlContent !== 'string') {
        throw new Error('No valid HTML content received');
    }

    const sizeInBytes = Buffer.byteLength(htmlContent, 'utf8');
    const sizeInMB = sizeInBytes / (1024 * 1024);

    console.log(`HTML content size: ${sizeInMB.toFixed(2)}MB`);

    if (sizeInBytes > CONFIG.MAX_HTML_SIZE) {
        console.warn(`⚠️  Large HTML detected (${sizeInMB.toFixed(2)}MB), truncating aggressively...`);
        // More aggressive truncation
        const truncatedHtml = htmlContent.substring(0, CONFIG.MAX_HTML_SIZE);
        // Ensure we end with proper closing tags
        return truncatedHtml + '</main></body></html>';
    }

    // Remove problematic scripts and heavy content for complex sites
    let cleanedHtml = htmlContent;
    if (sizeInMB > 1) { // For sites > 1MB
        console.log('🧹 Cleaning HTML for complex site...');
        cleanedHtml = cleanedHtml
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove all scripts
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove inline styles
            .replace(/on\w+="[^"]*"/gi, '') // Remove event handlers
            .replace(/style="[^"]*"/gi, '') // Remove inline styles
            .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '') // Remove iframes
            .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '') // Remove objects
            .replace(/<embed[^>]*>/gi, ''); // Remove embeds
    }

    return cleanedHtml;
};

// Completely rewritten accessibility analysis with better resource management
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
                setTimeout(() => global.gc(), 100); // Second GC after a delay
            }
        };

        try {
            console.log('🔍 Initializing JSDOM with strict security restrictions...');
            
            // Create JSDOM with minimal resource usage and timeouts
            const virtualConsole = new VirtualConsole();
            virtualConsole.on("error", () => {}); // Suppress all errors
            virtualConsole.on("warn", () => {}); // Suppress all warnings
            virtualConsole.on("jsdomError", () => {}); // Suppress JSDOM errors
            
            // Set JSDOM creation timeout
            jsdomTimeout = setTimeout(() => {
                cleanup();
                reject(new Error('JSDOM initialization timeout - site too complex'));
            }, CONFIG.JSDOM_TIMEOUT);

            dom = new JSDOM(htmlContent, {
                url: url,
                runScripts: "outside-only", // Safer than dangerously
                resources: "usable",
                pretendToBeVisual: false, // Reduce resource usage
                virtualConsole: virtualConsole,
                beforeParse(window) {
                    // Disable problematic APIs
                    window.alert = () => {};
                    window.confirm = () => false;
                    window.prompt = () => null;
                    window.open = () => null;
                    // Disable timers to prevent infinite loops
                    window.setTimeout = () => 0;
                    window.setInterval = () => 0;
                    window.requestAnimationFrame = () => 0;
                }
            });
            
            // Clear JSDOM timeout since creation succeeded
            if (jsdomTimeout) {
                clearTimeout(jsdomTimeout);
                jsdomTimeout = null;
            }
            
            const { window } = dom;
            const { document } = window;

            // Count DOM elements and check for complexity
            const elementCount = document.querySelectorAll('*').length;
            console.log(`📊 DOM elements found: ${elementCount}`);

            if (elementCount > CONFIG.MAX_DOM_ELEMENTS) {
                cleanup();
                reject(new Error(`Website too complex: ${elementCount} DOM elements (max: ${CONFIG.MAX_DOM_ELEMENTS}). Try a simpler page.`));
                return;
            }

            const isComplexSite = elementCount > CONFIG.COMPLEX_SITE_THRESHOLD;
            const actualTimeout = isComplexSite ? CONFIG.ANALYSIS_TIMEOUT * 0.75 : CONFIG.ANALYSIS_TIMEOUT;

            console.log(`🏗️  Site complexity: ${isComplexSite ? 'HIGH' : 'NORMAL'} (timeout: ${actualTimeout/1000}s)`);

            // Set analysis timeout
            analysisTimeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Analysis timeout after ${actualTimeout / 1000} seconds - website too complex`));
            }, actualTimeout);

            // Optimized axe configuration for complex sites
            const axeConfig = isComplexSite ? {
                rules: [
                    { id: 'bypass', enabled: true },
                    { id: 'color-contrast', enabled: false }, // Disable expensive rules
                    { id: 'focus-order-semantics', enabled: false },
                    { id: 'scrollable-region-focusable', enabled: false },
                    { id: 'css-orientation-lock', enabled: false }
                ]
            } : {
                rules: [
                    { id: 'bypass', enabled: true },
                    { id: 'color-contrast', enabled: true },
                    { id: 'focus-order-semantics', enabled: false }
                ]
            };

            const axeOptions = {
                runOnly: {
                    type: 'tag',  
                    values: isComplexSite ? ['wcag2a'] : ['wcag2a', 'wcag2aa'] // Reduced scope for complex sites
                },
                resultTypes: ['violations', 'incomplete'],
                elementRef: false,
                selectors: false,
                ancestry: false,
                xpath: false,
                performanceTimer: true // Enable performance monitoring
            };

            // More efficient axe execution
            const axeSource = `
                try {
                    ${axe.source};
                    
                    // Configure axe with performance optimizations
                    axe.configure(${JSON.stringify(axeConfig)});

                    const startTime = Date.now();
                    
                    axe.run(document, ${JSON.stringify(axeOptions)}).then(function(results) {
                        try {
                            const analysisTime = Date.now() - startTime;
                            console.log('⏱️  Axe analysis took: ' + analysisTime + 'ms');
                            
                            // Aggressive result limiting for complex sites
                            const maxViolations = ${isComplexSite ? 25 : 50};
                            const maxIncomplete = ${isComplexSite ? 10 : 25};
                            
                            const limitedResults = {
                                violations: (results.violations || []).slice(0, maxViolations),
                                incomplete: (results.incomplete || []).slice(0, maxIncomplete),
                                passes: (results.passes || []).length,
                                url: results.url,
                                timestamp: results.timestamp,
                                analysisTimeMs: analysisTime
                            };
                            
                            // Clean up nodes data aggressively
                            limitedResults.violations.forEach(violation => {
                                if (violation.nodes) {
                                    violation.nodes = violation.nodes.slice(0, 5).map(node => ({
                                        html: node.html ? node.html.substring(0, 100) + '...' : '',
                                        target: Array.isArray(node.target) ? node.target.slice(0, 2) : node.target,
                                        failureSummary: node.failureSummary ? node.failureSummary.substring(0, 150) + '...' : ''
                                    }));
                                }
                            });

                            limitedResults.incomplete.forEach(incomplete => {
                                if (incomplete.nodes) {
                                    incomplete.nodes = incomplete.nodes.slice(0, 3).map(node => ({
                                        html: node.html ? node.html.substring(0, 100) + '...' : '',
                                        target: Array.isArray(node.target) ? node.target.slice(0, 2) : node.target
                                    }));
                                }
                            });

                            window.axeResults = limitedResults;
                        } catch (processingError) {
                            window.axeError = 'Failed to process results: ' + processingError.message;
                        }
                    }).catch(function(axeRunError) {
                        window.axeError = 'Analysis failed: ' + axeRunError.message;
                    });
                } catch (setupError) {
                    window.axeError = 'Setup failed: ' + setupError.message;
                }
            `;

            // Execute axe analysis with error handling
            try {
                window.eval(axeSource);
            } catch (evalError) {
                cleanup();
                reject(new Error('Failed to execute accessibility analysis: ' + evalError.message));
                return;
            }

            // Optimized polling with faster intervals for complex sites
            let pollAttempts = 0;
            const maxPollAttempts = isComplexSite ? 300 : 600; // Fewer attempts for complex sites
            const pollInterval = isComplexSite ? 200 : 100; // Slower polling for complex sites

            const checkResults = () => {
                if (isCompleted) return;
                
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
                    reject(new Error('Analysis polling timeout - website too complex for analysis'));
                    return;
                }
                
                setTimeout(checkResults, pollInterval);
            };

            // Start polling
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
    }

    let htmlContent;
    try {
        console.log('🌐 Fetching HTML content...');
        
        const response = await axios.get(url, {
            timeout: CONFIG.REQUEST_TIMEOUT,
            maxRedirects: 2, // Further reduced redirects
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
                resultsTruncated: axeResults.violations.length >= 25
            },
            violations: axeResults.violations,
            incomplete: axeResults.incomplete,
            metadata: {
                analysisLimited: axeResults.violations.length >= 50,
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
    
    // Force shutdown after 20 seconds (reduced)
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
    console.log(`⚙️  Configuration: Max HTML ${CONFIG.MAX_HTML_SIZE / 1024 / 1024}MB, Max DOM ${CONFIG.MAX_DOM_ELEMENTS}, Timeout ${CONFIG.ANALYSIS_TIMEOUT / 1000}s`);
});

// Increase server timeout
server.timeout = CONFIG.REQUEST_TIMEOUT + 15000; // Add 15s buffer
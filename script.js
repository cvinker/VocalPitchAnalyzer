document.addEventListener('DOMContentLoaded', function() {
    // DOM elements
    const audioFile1Input = document.getElementById('audioFile1');
    const audioFile2Input = document.getElementById('audioFile2');
    const player1 = document.getElementById('player1');
    const player2 = document.getElementById('player2');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const avgPitch1Element = document.getElementById('avgPitch1');
    const minPitch1Element = document.getElementById('minPitch1');
    const maxPitch1Element = document.getElementById('maxPitch1');
    const avgPitch2Element = document.getElementById('avgPitch2');
    const minPitch2Element = document.getElementById('minPitch2');
    const maxPitch2Element = document.getElementById('maxPitch2');
    const pitchChartCanvas = document.getElementById('pitchChart');
    
    // Audio context and buffers
    let audioContext;
    let audioBuffer1;
    let audioBuffer2;
    
    // Chart instance
    let pitchChart;
    
    // Pitch data storage
    let pitchData1 = null;
    let pitchData2 = null;
    
    // Worker variables
    let pitchWorker = null;
    let useWorker = false;
    let pendingAnalysis = 0;
    
    // Function to clean pitch data for both statistics and visualization
    function cleanPitchData(pitchData) {
        if (!pitchData || pitchData.pitches.length === 0) {
            return null;
        }
        
        // Step 1: Filter by human vocal range
        const filteredIndices = [];
        for (let i = 0; i < pitchData.pitches.length; i++) {
            if (pitchData.pitches[i] >= 75 && pitchData.pitches[i] <= 350) {
                filteredIndices.push(i);
            }
        }
        
        if (filteredIndices.length === 0) {
            return null;
        }
        
        // Step 2: Get relevant data for valid indices
        const pitches = filteredIndices.map(i => pitchData.pitches[i]);
        const times = filteredIndices.map(i => pitchData.times[i]);
        const confidences = filteredIndices.map(i => pitchData.confidences[i]);
        
        // Step 3: Apply statistical outlier removal (IQR method)
        const sortedPitches = [...pitches].sort((a, b) => a - b);
        const q1Index = Math.floor(sortedPitches.length * 0.25);
        const q3Index = Math.floor(sortedPitches.length * 0.75);
        const q1 = sortedPitches[q1Index];
        const q3 = sortedPitches[q3Index];
        const iqr = q3 - q1;
        const lowerBound = q1 - (iqr * 1.5);
        const upperBound = q3 + (iqr * 1.5);
        
        // Filter again based on IQR
        const validIndices = [];
        for (let i = 0; i < pitches.length; i++) {
            if (pitches[i] >= lowerBound && pitches[i] <= upperBound) {
                validIndices.push(i);
            }
        }
        
        if (validIndices.length === 0) {
            return null;
        }
        
        // Get final filtered values
        const validPitches = validIndices.map(i => pitches[i]);
        const validTimes = validIndices.map(i => times[i]);
        const validConfidences = validIndices.map(i => confidences[i]);
        
        // Step 4: Find continuous segments (actual speech vs. isolated sounds)
        let segments = [];
        let currentSegment = [0]; // Start with first point
        
        for (let i = 1; i < validPitches.length; i++) {
            if (validTimes[i] - validTimes[i-1] < 0.1) { // 100ms threshold for continuity
                currentSegment.push(i);
            } else {
                if (currentSegment.length >= 3) { // Minimum length for a valid segment
                    segments.push(currentSegment);
                }
                currentSegment = [i];
            }
        }
        
        // Add last segment if it's long enough
        if (currentSegment.length >= 3) {
            segments.push(currentSegment);
        }
        
        let finalPitches, finalTimes, finalConfidences;
        
        // If we have continuous segments, use those
        if (segments.length > 0) {
            // Get all values from continuous segments
            finalPitches = segments.flatMap(segment => 
                segment.map(i => validPitches[i]));
            finalTimes = segments.flatMap(segment => 
                segment.map(i => validTimes[i]));
            finalConfidences = segments.flatMap(segment => 
                segment.map(i => validConfidences[i]));
        } else {
            // If no continuous segments, use all valid values
            finalPitches = validPitches;
            finalTimes = validTimes;
            finalConfidences = validConfidences;
        }
        
        // Return cleaned data
        return {
            times: finalTimes,
            pitches: finalPitches,
            confidences: finalConfidences
        };
    }
    
    // Define the worker code as a string (to create a blob URL)
    const workerCode = `
        // Worker for pitch detection processing to prevent UI freezing

        // Process a message from the main thread
        self.onmessage = function(e) {
            const data = e.data;
            
            if (data.command === 'analyze') {
                try {
                    // Process the audio data
                    const pitchData = processAudioFile(
                        data.channels,
                        data.sampleRate,
                        data.fileNumber
                    );
                    
                    // Send back the results
                    self.postMessage({
                        type: 'result',
                        fileNumber: data.fileNumber,
                        pitchData: pitchData
                    });
                } catch (error) {
                    // Send back error
                    self.postMessage({
                        type: 'error',
                        fileNumber: data.fileNumber,
                        message: error.message || 'Unknown error processing audio'
                    });
                }
            }
        };

        // Process a single audio file
        function processAudioFile(channels, sampleRate, fileNumber) {
            // For very long files, we'll analyze only the first 60 seconds
            const maxDuration = 60; // seconds
            const maxSamples = maxDuration * sampleRate;
            const samplesToAnalyze = Math.min(channels[0].length, maxSamples);
            
            // Report initial progress
            self.postMessage({
                type: 'progress',
                fileNumber: fileNumber,
                progress: 0
            });
            
            // Step 1: Convert audio buffer to mono
            const numChannels = channels.length;
            
            // Create a mono buffer by averaging all channels
            const monoBuffer = new Float32Array(samplesToAnalyze);
            for (let i = 0; i < samplesToAnalyze; i++) {
                let sum = 0;
                for (let channel = 0; channel < numChannels; channel++) {
                    sum += channels[channel][i];
                }
                monoBuffer[i] = sum / numChannels;
            }
            
            // Step 2: Use window size appropriate for pitch detection
            const windowSize = 2048; // ~46ms at 44.1kHz
            const hopSize = 512; // 75% overlap
            
            const pitchData = {
                times: [],
                pitches: [],
                confidences: []
            };
            
            // Process audio in chunks and report progress periodically
            const totalChunks = Math.floor((monoBuffer.length - windowSize) / hopSize);
            const progressUpdateInterval = Math.max(1, Math.floor(totalChunks / 100)); // Update progress ~100 times
            
            for (let i = 0, chunkIndex = 0; i < monoBuffer.length - windowSize; i += hopSize, chunkIndex++) {
                // Extract a chunk of audio
                const chunk = monoBuffer.slice(i, i + windowSize);
                
                // Use YIN pitch detection algorithm
                const [pitch, clarity] = detectPitchYin(chunk, sampleRate);
                
                // Only include pitch values that are in the human voice range and have decent clarity
                if (pitch >= 75 && pitch <= 350 && clarity > 0.6) {
                    pitchData.times.push(i / sampleRate);
                    pitchData.pitches.push(pitch);
                    pitchData.confidences.push(clarity);
                }
                
                // Report progress periodically
                if (chunkIndex % progressUpdateInterval === 0 || chunkIndex === totalChunks - 1) {
                    const progress = (chunkIndex / totalChunks) * 100;
                    self.postMessage({
                        type: 'progress',
                        fileNumber: fileNumber,
                        progress: progress
                    });
                }
            }
            
            // Post-process: smooth the data
            if (pitchData.pitches.length > 0) {
                // Apply median filter to remove outliers
                const smoothedPitches = [...pitchData.pitches];
                for (let i = 2; i < pitchData.pitches.length - 2; i++) {
                    const window = [
                        pitchData.pitches[i-2],
                        pitchData.pitches[i-1],
                        pitchData.pitches[i],
                        pitchData.pitches[i+1],
                        pitchData.pitches[i+2]
                    ].sort((a, b) => a - b);
                    smoothedPitches[i] = window[2]; // Median value
                }
                
                pitchData.pitches = smoothedPitches;
            }
            
            // Final progress update
            self.postMessage({
                type: 'progress',
                fileNumber: fileNumber,
                progress: 100
            });
            
            return pitchData;
        }

        // YIN pitch detection algorithm implementation
        function detectPitchYin(buffer, sampleRate) {
            const threshold = 0.15; // Adjusted threshold for better sensitivity (was 0.2)
            const minFreq = 75;  // Adjusted min frequency for human voice
            const maxFreq = 350; // Adjusted max frequency for human voice
            
            // Calculate the maximum and minimum periods in samples
            const maxPeriod = Math.floor(sampleRate / minFreq);
            const minPeriod = Math.ceil(sampleRate / maxFreq);
            
            // Create the buffer of difference values
            const yinBuffer = new Float32Array(maxPeriod);
            
            // Step 1: Calculate autocorrelation for each delay (tau)
            for (let tau = 0; tau < maxPeriod; tau++) {
                yinBuffer[tau] = 0;
                
                // To save computation, use a subset of the buffer
                const bufferSize = Math.min(buffer.length - maxPeriod, maxPeriod);
                
                // Calculate the squared difference
                for (let i = 0; i < bufferSize; i++) {
                    const delta = buffer[i] - buffer[i + tau];
                    yinBuffer[tau] += delta * delta;
                }
            }
            
            // Step 2: Calculate the cumulative mean normalized difference
            let runningSum = 0;
            yinBuffer[0] = 1; // Set the first value to 1 to avoid division by zero
            
            for (let tau = 1; tau < maxPeriod; tau++) {
                runningSum += yinBuffer[tau];
                yinBuffer[tau] = yinBuffer[tau] * tau / runningSum;
            }
            
            // Step 3: Find the first minimum below the threshold
            let minTau = 0;
            let minVal = 1;
            
            // Start from minimum period to avoid low frequency errors
            for (let tau = minPeriod; tau < maxPeriod; tau++) {
                if (yinBuffer[tau] < threshold) {
                    // Look for the minimum value in this dip
                    while (tau + 1 < maxPeriod && yinBuffer[tau + 1] < yinBuffer[tau]) {
                        tau++;
                    }
                    // Found a minimum
                    return [sampleRate / tau, 1 - yinBuffer[tau]];
                }
                
                // Keep track of the overall minimum in case we don't find one below threshold
                if (yinBuffer[tau] < minVal) {
                    minVal = yinBuffer[tau];
                    minTau = tau;
                }
            }
            
            // If no value below threshold, use the minimum value we found
            if (minTau > 0) {
                return [sampleRate / minTau, 1 - minVal];
            }
            
            // No pitch found
            return [0, 0];
        }
    `;

    // Initialize worker using Blob URL
    function initWorker() {
        if (!pitchWorker && window.Worker) {
            try {
                // Create a blob URL for the worker script
                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                
                // Create the worker and set up message handling
                pitchWorker = new Worker(workerUrl);
                
                pitchWorker.onmessage = function(e) {
                    const data = e.data;
                    
                    if (data.type === 'progress') {
                        // Update progress bar
                        progressFill.style.width = data.progress + '%';
                        progressText.textContent = `Analyzing file ${data.fileNumber}... ${Math.round(data.progress)}%`;
                    } 
                    else if (data.type === 'result') {
                        pendingAnalysis--;
                        
                        // Store results
                        if (data.fileNumber === 1) {
                            pitchData1 = data.pitchData;
                            updateStats(pitchData1, avgPitch1Element, minPitch1Element, maxPitch1Element);
                        } else {
                            pitchData2 = data.pitchData;
                            updateStats(pitchData2, avgPitch2Element, minPitch2Element, maxPitch2Element);
                        }
                        
                        // Check if all files are processed
                        if (pendingAnalysis === 0) {
                            finishAnalysis();
                        }
                    }
                    else if (data.type === 'error') {
                        console.error('Worker error:', data.message);
                        pendingAnalysis--;
                        progressText.textContent = 'Error analyzing audio: ' + data.message;
                        
                        if (pendingAnalysis === 0) {
                            setTimeout(() => {
                                finishAnalysis();
                            }, 2000);
                        }
                    }
                };
                
                pitchWorker.onerror = function(error) {
                    console.error('Worker error:', error);
                    useWorker = false;
                    pendingAnalysis = 0;
                    progressText.textContent = 'Error with pitch analysis. Trying alternative method...';
                    
                    // Fall back to non-worker method
                    setTimeout(() => {
                        analyzeAudioFallback();
                    }, 500);
                };
                
                // Mark that we can use the worker
                useWorker = true;
                
            } catch (error) {
                console.error('Failed to initialize worker:', error);
                useWorker = false;
            }
        } else {
            useWorker = false;
        }
    }
    
    // Initialize audio context when user interacts with the page
    function initAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }
    
    // Event listeners for file inputs
    audioFile1Input.addEventListener('change', function(e) {
        initAudioContext();
        handleFileUpload(e.target.files[0], player1, 1);
    });
    
    audioFile2Input.addEventListener('change', function(e) {
        initAudioContext();
        handleFileUpload(e.target.files[0], player2, 2);
    });
    
    // Handle file upload and create audio buffers
    function handleFileUpload(file, player, fileNumber) {
        if (!file) return;
        
        const fileURL = URL.createObjectURL(file);
        player.src = fileURL;
        
        // Show loading state
        const container = player.closest('.upload-container');
        let loadingIndicator = container.querySelector('.loading-indicator');
        
        if (!loadingIndicator) {
            loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            container.appendChild(loadingIndicator);
        }
        loadingIndicator.textContent = 'Loading audio...';
        
        // Decode the audio file into an audio buffer
        const fileReader = new FileReader();
        fileReader.onload = function(e) {
            audioContext.decodeAudioData(e.target.result)
                .then(buffer => {
                    if (fileNumber === 1) {
                        audioBuffer1 = buffer;
                    } else {
                        audioBuffer2 = buffer;
                    }
                    
                    // Enable analyze button if at least one file is loaded
                    if (audioBuffer1 || audioBuffer2) {
                        analyzeBtn.disabled = false;
                    }
                    
                    // Remove loading indicator
                    if (loadingIndicator) {
                        container.removeChild(loadingIndicator);
                    }
                })
                .catch(err => {
                    console.error('Error decoding audio data', err);
                    if (loadingIndicator) {
                        container.removeChild(loadingIndicator);
                    }
                    
                    const errorMsg = document.createElement('div');
                    errorMsg.className = 'error-message';
                    errorMsg.textContent = 'Error loading audio. Please try another file.';
                    container.appendChild(errorMsg);
                    
                    setTimeout(() => {
                        if (container.contains(errorMsg)) {
                            container.removeChild(errorMsg);
                        }
                    }, 5000);
                });
        };
        
        fileReader.readAsArrayBuffer(file);
    }
    
    // Analyze button click handler
    analyzeBtn.addEventListener('click', function() {
        if (!audioBuffer1 && !audioBuffer2) {
            alert('Please upload at least one audio file to analyze.');
            return;
        }
        
        // Initialize the worker if we haven't tried yet
        if (pitchWorker === null) {
            initWorker();
        }
        
        // Reset progress and show progress container
        progressFill.style.width = '0%';
        progressText.textContent = 'Preparing analysis...';
        progressContainer.classList.remove('hidden');
        
        // Disable button during analysis
        analyzeBtn.disabled = true;
        
        // Reset pitch data
        pitchData1 = null;
        pitchData2 = null;
        
        // Start analysis
        if (useWorker) {
            analyzeAudioWithWorker();
        } else {
            analyzeAudioFallback();
        }
    });
    
    // Analyze audio using the web worker
    function analyzeAudioWithWorker() {
        pendingAnalysis = 0;
        
        // Process file 1 if it exists
        if (audioBuffer1) {
            pendingAnalysis++;
            
            // Extract channel data from buffer
            const channels = [];
            for (let i = 0; i < audioBuffer1.numberOfChannels; i++) {
                channels.push(new Float32Array(audioBuffer1.getChannelData(i)));
            }
            
            // Send to worker
            pitchWorker.postMessage({
                command: 'analyze',
                fileNumber: 1,
                channels: channels,
                sampleRate: audioBuffer1.sampleRate
            });
        }
        
        // Process file 2 if it exists
        if (audioBuffer2) {
            pendingAnalysis++;
            
            // Extract channel data from buffer
            const channels = [];
            for (let i = 0; i < audioBuffer2.numberOfChannels; i++) {
                channels.push(new Float32Array(audioBuffer2.getChannelData(i)));
            }
            
            // Send to worker
            pitchWorker.postMessage({
                command: 'analyze',
                fileNumber: 2,
                channels: channels,
                sampleRate: audioBuffer2.sampleRate
            });
        }
        
        // If no files were processed, finish up
        if (pendingAnalysis === 0) {
            finishAnalysis();
        }
    }
    
    // Fallback method without worker
    function analyzeAudioFallback() {
        // Process files sequentially
        Promise.resolve()
            .then(() => {
                if (audioBuffer1) {
                    progressText.textContent = 'Analyzing file 1...';
                    return processAudioFileFallback(audioBuffer1, 1);
                }
                return null;
            })
            .then((data) => {
                pitchData1 = data;
                if (pitchData1) {
                    updateStats(pitchData1, avgPitch1Element, minPitch1Element, maxPitch1Element);
                }
                
                if (audioBuffer2) {
                    progressText.textContent = 'Analyzing file 2...';
                    return processAudioFileFallback(audioBuffer2, 2);
                }
                return null;
            })
            .then((data) => {
                pitchData2 = data;
                if (pitchData2) {
                    updateStats(pitchData2, avgPitch2Element, minPitch2Element, maxPitch2Element);
                }
                
                // Finish up
                finishAnalysis();
            })
            .catch(error => {
                console.error('Error during analysis:', error);
                progressText.textContent = 'Error analyzing audio.';
                setTimeout(finishAnalysis, 2000);
            });
    }
    
    // Process audio in main thread (fallback)
    function processAudioFileFallback(audioBuffer, fileNumber) {
        return new Promise((resolve) => {
            // For very long files, we'll analyze only the first 60 seconds
            const maxDuration = 60; // seconds
            const samplesToAnalyze = Math.min(audioBuffer.length, maxDuration * audioBuffer.sampleRate);
            
            // Extract mono data
            const numChannels = audioBuffer.numberOfChannels;
            const sampleRate = audioBuffer.sampleRate;
            
            // Create a mono buffer by averaging all channels
            const monoBuffer = new Float32Array(samplesToAnalyze);
            for (let i = 0; i < samplesToAnalyze; i++) {
                let sum = 0;
                for (let channel = 0; channel < numChannels; channel++) {
                    sum += audioBuffer.getChannelData(channel)[i];
                }
                monoBuffer[i] = sum / numChannels;
            }
            
            // Process the data in chunks with timeouts to prevent freezing
            const windowSize = 2048;
            const hopSize = 512;
            
            const pitchData = {
                times: [],
                pitches: [],
                confidences: []
            };
            
            const totalHops = Math.floor((monoBuffer.length - windowSize) / hopSize);
            let currentHop = 0;
            const chunkSize = 200; // Process this many hops at a time
            
            progressFill.style.width = '0%';
            
            // Process a chunk of audio
            function processChunk() {
                const endHop = Math.min(currentHop + chunkSize, totalHops);
                
                for (let hop = currentHop; hop < endHop; hop++) {
                    const i = hop * hopSize;
                    const chunk = monoBuffer.slice(i, i + windowSize);
                    
                    // Use YIN pitch detection algorithm
                    const [pitch, clarity] = detectPitchYinFallback(chunk, sampleRate);
                    
                    // Only include pitch values that are in the human voice range and have decent clarity
                    if (pitch >= 75 && pitch <= 350 && clarity > 0.6) {
                        pitchData.times.push(i / sampleRate);
                        pitchData.pitches.push(pitch);
                        pitchData.confidences.push(clarity);
                    }
                }
                
                currentHop = endHop;
                
                // Update progress
                const progress = (currentHop / totalHops) * 100;
                progressFill.style.width = progress + '%';
                progressText.textContent = `Analyzing file ${fileNumber}... ${Math.round(progress)}%`;
                
                // Continue if more to process
                if (currentHop < totalHops) {
                    setTimeout(processChunk, 0);
                } else {
                    // Apply final processing
                    if (pitchData.pitches.length > 0) {
                        // Apply median filter to remove outliers
                        const smoothedPitches = [...pitchData.pitches];
                        for (let i = 2; i < pitchData.pitches.length - 2; i++) {
                            const window = [
                                pitchData.pitches[i-2],
                                pitchData.pitches[i-1],
                                pitchData.pitches[i],
                                pitchData.pitches[i+1],
                                pitchData.pitches[i+2]
                            ].sort((a, b) => a - b);
                            smoothedPitches[i] = window[2]; // Median value
                        }
                        
                        pitchData.pitches = smoothedPitches;
                    }
                    
                    // All done
                    resolve(pitchData);
                }
            }
            
            // Start processing
            setTimeout(processChunk, 0);
        });
    }
    
    // YIN algorithm for the fallback method
    function detectPitchYinFallback(buffer, sampleRate) {
        const threshold = 0.15; // Adjusted threshold for better sensitivity (was 0.2)
        const minFreq = 75;  // Adjusted min frequency for human voice
        const maxFreq = 350; // Adjusted max frequency for human voice
        
        // Calculate the maximum and minimum periods in samples
        const maxPeriod = Math.floor(sampleRate / minFreq);
        const minPeriod = Math.ceil(sampleRate / maxFreq);
        
        // Create the buffer of difference values
        const yinBuffer = new Float32Array(maxPeriod);
        
        // Step 1: Calculate autocorrelation for each delay (tau)
        for (let tau = 0; tau < maxPeriod; tau++) {
            yinBuffer[tau] = 0;
            
            // To save computation, use a subset of the buffer
            const bufferSize = Math.min(buffer.length - maxPeriod, maxPeriod);
            
            // Calculate the squared difference
            for (let i = 0; i < bufferSize; i++) {
                const delta = buffer[i] - buffer[i + tau];
                yinBuffer[tau] += delta * delta;
            }
        }
        
        // Step 2: Calculate the cumulative mean normalized difference
        let runningSum = 0;
        yinBuffer[0] = 1; // Set the first value to 1 to avoid division by zero
        
        for (let tau = 1; tau < maxPeriod; tau++) {
            runningSum += yinBuffer[tau];
            yinBuffer[tau] = yinBuffer[tau] * tau / runningSum;
        }
        
        // Step 3: Find the first minimum below the threshold
        let minTau = 0;
        let minVal = 1;
        
        // Start from minimum period to avoid low frequency errors
        for (let tau = minPeriod; tau < maxPeriod; tau++) {
            if (yinBuffer[tau] < threshold) {
                // Look for the minimum value in this dip
                while (tau + 1 < maxPeriod && yinBuffer[tau + 1] < yinBuffer[tau]) {
                    tau++;
                }
                // Found a minimum
                return [sampleRate / tau, 1 - yinBuffer[tau]];
            }
            
            // Keep track of the overall minimum in case we don't find one below threshold
            if (yinBuffer[tau] < minVal) {
                minVal = yinBuffer[tau];
                minTau = tau;
            }
        }
        
        // If no value below threshold, use the minimum value we found
        if (minTau > 0) {
            return [sampleRate / minTau, 1 - minVal];
        }
        
        // No pitch found
        return [0, 0];
    }
    
    // Complete the analysis process
    function finishAnalysis() {
        // Create or update chart
        createPitchChart(pitchData1, pitchData2);
        
        // Hide progress container
        progressContainer.classList.add('hidden');
        
        // Re-enable analyze button
        analyzeBtn.disabled = false;
    }
    
    // Update stats display
    function updateStats(pitchData, avgElement, minElement, maxElement) {
        // Use the cleaned data
        const cleanedData = cleanPitchData(pitchData);
        
        if (!cleanedData) {
            avgElement.textContent = 'No valid pitch detected';
            minElement.textContent = '-';
            maxElement.textContent = '-';
            return;
        }
        
        // Calculate statistics from cleaned data
        const finalPitches = cleanedData.pitches;
        
        // Sort for percentile calculations
        const sortedFinalPitches = [...finalPitches].sort((a, b) => a - b);
        
        // Calculate percentiles
        const medianIndex = Math.floor(sortedFinalPitches.length / 2);
        const q1FinalIndex = Math.floor(sortedFinalPitches.length * 0.25);
        const q3FinalIndex = Math.floor(sortedFinalPitches.length * 0.75);
        
        const median = sortedFinalPitches[medianIndex];
        const q1Final = sortedFinalPitches[q1FinalIndex];
        const q3Final = sortedFinalPitches[q3FinalIndex];
        
        // Final statistics
        const avg = Math.round(median); // Use median as it's more robust
        const min = Math.round(Math.min(...finalPitches));
        const max = Math.round(Math.max(...finalPitches));
        const speakingRangeLow = Math.round(q1Final);
        const speakingRangeHigh = Math.round(q3Final);
        
        avgElement.textContent = `${avg} Hz (Range: ${speakingRangeLow}-${speakingRangeHigh} Hz)`;
        minElement.textContent = `${min} Hz`;
        maxElement.textContent = `${max} Hz`;
    }
    
    // Create pitch chart
    function createPitchChart(pitchData1, pitchData2) {
        // Destroy previous chart if it exists
        if (pitchChart) {
            pitchChart.destroy();
        }
        
        // Clean the data for visualization
        const cleanedData1 = cleanPitchData(pitchData1);
        const cleanedData2 = cleanPitchData(pitchData2);
        
        const datasets = [];
        
        // Add dataset for file 1 if available
        if (cleanedData1 && cleanedData1.times.length > 0) {
            datasets.push({
                label: 'File 1',
                data: cleanedData1.times.map((time, i) => ({
                    x: time,
                    y: cleanedData1.pitches[i]
                })),
                borderColor: 'rgba(255, 105, 180, 0.9)',  // More vibrant
                backgroundColor: 'rgba(255, 105, 180, 0.2)',
                borderWidth: 2.5,  // Thicker line
                pointRadius: 0,
                tension: 0.2,  // Less smoothing for accuracy
                fill: false
            });
        }
        
        // Add dataset for file 2 if available
        if (cleanedData2 && cleanedData2.times.length > 0) {
            datasets.push({
                label: 'File 2',
                data: cleanedData2.times.map((time, i) => ({
                    x: time,
                    y: cleanedData2.pitches[i]
                })),
                borderColor: 'rgba(65, 105, 225, 0.9)',  // More vibrant
                backgroundColor: 'rgba(65, 105, 225, 0.2)',
                borderWidth: 2.5,  // Thicker line
                pointRadius: 0,
                tension: 0.2,  // Less smoothing for accuracy
                fill: false
            });
        }
        
        // Find max time for setting annotation width
        const maxTime = datasets.length > 0 
            ? Math.max(...datasets.flatMap(ds => ds.data.map(d => d.x))) 
            : 10;
        
        // Create the chart with improved options
        pitchChart = new Chart(pitchChartCanvas, {
            type: 'line',
            data: {
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Time (seconds)',
                            font: {
                                size: 14,
                                weight: 'bold'
                            },
                            padding: {top: 10, bottom: 0}
                        },
                        ticks: {
                            font: {
                                size: 12
                            },
                            color: '#555'
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)'  // Lighter grid lines
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Pitch (Hz)',
                            font: {
                                size: 14,
                                weight: 'bold'
                            },
                            padding: {top: 0, bottom: 10}
                        },
                        min: 75,  // Focused on vocal range
                        max: 350, // Focused on vocal range
                        ticks: {
                            font: {
                                size: 12
                            },
                            color: '#555',
                            callback: function(value) {
                                return value + ' Hz';
                            },
                            stepSize: 50  // Ticks every 50 Hz for better readability
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)'  // Lighter grid lines
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        titleFont: {
                            size: 14
                        },
                        bodyFont: {
                            size: 13
                        },
                        callbacks: {
                            label: function(context) {
                                return `${context.dataset.label}: ${Math.round(context.parsed.y)} Hz`;
                            }
                        }
                    },
                    legend: {
                        labels: {
                            font: {
                                size: 14
                            },
                            padding: 20
                        }
                    },
                    annotation: {
                        annotations: {
                            // Add labels directly on the chart
                            maleLabel: {
                                type: 'label',
                                xValue: maxTime / 20,  // Position at 5% of max time
                                yValue: 130,  // Middle of male range
                                backgroundColor: 'rgba(0, 123, 255, 0.7)',
                                content: 'Male',
                                font: {
                                    size: 12
                                },
                                color: 'white',
                                padding: 4
                            },
                            androLabel: {
                                type: 'label',
                                xValue: maxTime / 20,
                                yValue: 160,
                                backgroundColor: 'rgba(108, 117, 125, 0.7)',
                                content: 'Androgynous',
                                font: {
                                    size: 12
                                },
                                color: 'white',
                                padding: 4
                            },
                            femaleLabel: {
                                type: 'label',
                                xValue: maxTime / 20,
                                yValue: 210,
                                backgroundColor: 'rgba(255, 105, 180, 0.7)',
                                content: 'Female',
                                font: {
                                    size: 12
                                },
                                color: 'white',
                                padding: 4
                            },
                            maleRange: {
                                type: 'box',
                                xMin: 0,
                                xMax: maxTime,
                                yMin: 85,
                                yMax: 180,
                                backgroundColor: 'rgba(0, 123, 255, 0.1)',
                                borderWidth: 0
                            },
                            androRange: {
                                type: 'box',
                                xMin: 0,
                                xMax: maxTime,
                                yMin: 145,
                                yMax: 175,
                                backgroundColor: 'rgba(108, 117, 125, 0.15)',
                                borderWidth: 0
                            },
                            femaleRange: {
                                type: 'box',
                                xMin: 0,
                                xMax: maxTime,
                                yMin: 165,
                                yMax: 255,
                                backgroundColor: 'rgba(255, 105, 180, 0.1)',
                                borderWidth: 0
                            }
                        }
                    }
                }
            }
        });
    }
});
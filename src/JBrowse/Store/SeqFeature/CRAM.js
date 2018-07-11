const { IndexedCramFile, CraiIndex } = cjsRequire('@gmod/cram/src')
const { Buffer } = cjsRequire('buffer')

define( [
            'dojo/_base/declare',
            'JBrowse/Store/SeqFeature',
            'JBrowse/Store/DeferredStatsMixin',
            'JBrowse/Store/DeferredFeaturesMixin',
            'JBrowse/Store/SeqFeature/GlobalStatsEstimationMixin',
            'JBrowse/Model/XHRBlob',
            'JBrowse/Model/SimpleFeature',
        ],
        function(
            declare,
            SeqFeatureStore,
            DeferredStatsMixin,
            DeferredFeaturesMixin,
            GlobalStatsEstimationMixin,
            XHRBlob,
            SimpleFeature,
        ) {


// wrapper class to make old JBrowse *Blob data access classes work with
// the new-style filehandle API expected by the cram code

class BlobWrapper {
    constructor(oldStyleBlob) {
        this.blob = oldStyleBlob
    }

    read(buffer, offset = 0, length, position) {
        return new Promise((resolve,reject) => {
            this.blob.read(
                position,
                length,
                dataArrayBuffer => {
                    const data = Buffer.from(dataArrayBuffer)
                    data.copy(buffer, offset)
                    resolve()
                },
                reject,
            )
        })
    }

    readFile() {
        return new Promise((resolve, reject) => {
            this.blob.fetch( dataArrayBuffer => {
                resolve(Buffer.from(dataArrayBuffer))
            }, reject)
        })
    }

    stat() {
        return new Promise((resolve, reject) => {
            this.blob.stat(resolve, reject)
        })
    }
}


return declare( [ SeqFeatureStore, DeferredStatsMixin, DeferredFeaturesMixin, GlobalStatsEstimationMixin ],

/**
 * @lends JBrowse.Store.SeqFeature.CRAM
 */
{
    /**
     * Data backend for reading feature data directly from a
     * web-accessible CRAM file.
     *
     * @constructs
     */
    constructor: function( args ) {
        const cramArgs = {}

        let dataBlob
        if (args.cram)
            dataBlob = args.cram
        else if (args.urlTemplate)
            dataBlob = new XHRBlob(this.resolveUrl(args.urlTemplate || 'data.cram'))
        else throw new Error('must provide either `cram` or `urlTemplate`')
        cramArgs.cramFilehandle = new BlobWrapper(dataBlob)

        if (args.crai)
            cramArgs.index = new CraiIndex({ filehandle: new BlobWrapper(args.crai)})
        else if (args.craiUrlTemplate)
            cramArgs.index = new CraiIndex({filehandle: new BlobWrapper(new XHRBlob(this.resolveUrl(args.craiUrlTemplate)))})
        else throw new Error('no index provided, must provide a CRAM index')
        // TODO: need to add .csi index support

        cramArgs.seqFetch = this._seqFetch.bind(this)
        cramArgs.checkSequenceMD5 = false

        this.cram = new IndexedCramFile(cramArgs)

        this.source = ( dataBlob.url  ? dataBlob.url.match( /\/([^/\#\?]+)($|[\#\?])/ )[1] :
                        dataBlob.blob ? dataBlob.blob.name : undefined ) || undefined;

        // pre-download the index before running the statistics estimation so that the stats
        // estimation doesn't time out
        this.cram.hasDataForReferenceSequence(0)
            .then( () => {
                this._deferred.features.resolve({success:true});
            })
            .then( () => this._estimateGlobalStats())
            .then( stats => {
                this.globalStats = stats;
                this._deferred.stats.resolve({success:true});
            })
            .catch(err => {
                this._deferred.features.reject(err)
                this._deferred.stats.reject(err)
            })

        this.storeTimeout = args.storeTimeout || 3000;
    },

    _getRefSeqStore() {
        return new Promise((resolve,reject) => {
            this.browser.getStore('refseqs',resolve,reject)
        })
    },

    // used by the CRAM backend to fetch a region of the underlying reference
    // sequence.  needed for some of its calculations
    async _seqFetch(seqId, start, end) {
        start -= 1 // convert from 1-based closed to interbase

        const refSeqStore = await this._getRefSeqStore()
        if (!refSeqStore) return undefined
        const refName = this._refIdToName(seqId)
        if (!refName) return undefined

        const seqChunks = await new Promise((resolve,reject) => {
            let features = []
            refSeqStore.getFeatures(
                {ref: refName, start: start-1, end},
                f => features.push(f),
                () => resolve(features),
                reject
            )
        })

        const trimmed = []
        seqChunks
        .sort((a,b) => a.get('start') - b.get('start'))
        .forEach( (chunk,i) => {
            let chunkStart = chunk.get('start')
            let chunkEnd = chunk.get('end')
            let trimStart = Math.max(start - chunkStart, 0)
            let trimEnd = Math.min(end - chunkStart, chunkEnd-chunkStart)
            let trimLength = trimEnd - trimStart
            let chunkSeq = chunk.get('seq') || chunk.get('residues')
            trimmed.push(chunkSeq.substr(trimStart,trimLength))
        })

        const sequence = trimmed.join('')
        if (sequence.length !== (end-start))
            throw new Error('sequence fetch sanity check failed')
        return sequence
    },

    _refNameToId(refName) {
        return this.browser.getRefSeqNumber(refName)
    },

    _refIdToName(refId) {
        let ref = this.browser.getRefSeqById(refId)
        return ref ? ref.name : undefined
    },

    /**
     * Interrogate whether a store has data for a given reference
     * sequence.  Calls the given callback with either true or false.
     *
     * Implemented as a binary interrogation because some stores are
     * smart enough to regularize reference sequence names, while
     * others are not.
     */
    hasRefSeq: function( seqName, callback, errorCallback ) {
        seqName = this.browser.regularizeReferenceName( seqName );
        const refSeqNumber = this._refNameToId(seqName)
        if (refSeqNumber === undefined) callback(false)

        this._deferred.stats
        .then(() => this.cram.hasDataForReferenceSequence(refSeqNumber))
        .then(callback, errorCallback)
    },

    // called by getFeatures from the DeferredFeaturesMixin
    _getFeatures: function( query, featCallback, endCallback, errorCallback ) {
        //this.bam.fetch( query.ref ? query.ref : this.refSeq.name, query.start, query.end, featCallback, endCallback, errorCallback );
        const seqName = query.ref || this.refSeq.name
        const refSeqNumber = this._refNameToId(seqName)
        if (refSeqNumber === undefined) {
            endCallback()
            return
        }

        this.cram.getFeaturesForRange(refSeqNumber, query.start+1, query.end)
            .then(records => {
                records.forEach( record => {
                    featCallback( this._cramRecordToFeature(record))
                })

                endCallback()
            })
            .catch(errorCallback)
    },

    _cramRecordToFeature(record) {
        const data = {
            name: record.readName,
            start: record.alignmentStart-1,
            end: record.alignmentStart+record.lengthOnRef-1,
            cram_read_features: record.readFeatures,
            type: 'match',
            MQ: record.mappingQuality,
            flags: `0x${record.flags.toString(16)}`,
            cramFlags: `0x${record.cramFlags.toString(16)}`,
            strand: record.isReverseComplemented() ? -1 : 1,
            qual: (record.qualityScores || []).map(q => q+33).join(' '),
            seq: record.readBases,

            qc_failed: record.isFailedQc(),
            secondary_alignment: record.isSecondary(),
            supplementary_alignment: record.isSupplementary(),
            multi_segment_template: record.isPaired(),
            multi_segment_all_correctly_aligned: record.isProperlyPaired(),
            multi_segment_next_segment_unmapped: record.isMateUnmapped(),
            unmapped: record.isSegmentUnmapped(),
            next_seq_id: record.mate ? this._refIdToName(record.mate.sequenceID) : undefined,
            next_segment_position: record.mate
                ? ( this._refIdToName(record.mate.sequenceID)+':'+record.mate.alignmentStart) : undefined,
        }
        Object.assign(data,record.tags || {})
        return new SimpleFeature({
            data,
            id: record.uniqueId
        })
    },

    saveStore: function() {
        return {
            urlTemplate: this.config.bam.url,
            baiUrlTemplate: this.config.bai.url
        };
    }

});
});
